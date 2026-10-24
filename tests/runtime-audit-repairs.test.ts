import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { classifyVerificationPolicy } from '../src/core/capabilities.js';
import { estimateMessageTokens, estimateToolSchemaTokens } from '../src/core/context.js';
import { AgentRuntime, type RuntimeOptions } from '../src/core/runtime.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import type { ProviderRegistry } from '../src/providers/registry.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderStreamEvent,
} from '../src/providers/types.js';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { initWorkspace } from '../src/workspace/fs.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(
  behavior: (index: number, request: ProviderRequest) => AsyncIterable<ProviderStreamEvent>,
  configure?: (options: RuntimeOptions) => void,
) {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-runtime-repairs-'));
  await initWorkspace(root);
  const config = defaultRuntimeConfig(root);
  config.provider.name = 'audit-repairs';
  const store = new DatabaseStore(openAppDatabase(root));
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    name: 'audit-repairs',
    model: 'fixture',
    async *stream(request) {
      requests.push(structuredClone({ ...request, signal: undefined, dynamicTools: undefined }));
      yield* behavior(requests.length, request);
    },
    async embed() {
      throw new Error('No network embeddings in fixture');
    },
    async health() {
      return { name: 'audit-repairs', available: true, detail: 'controlled fixture' };
    },
  };
  const providers = {
    get(name: string) {
      if (name !== provider.name) throw new Error('Unavailable fixture provider');
      return provider;
    },
    list: () => [provider.name],
  } as unknown as ProviderRegistry;
  const tools = new ToolRegistry(
    root,
    undefined,
    { browserEnabled: false, searchEnabled: false },
    { store },
  );
  const options: RuntimeOptions = { root, config, store, providers, tools };
  configure?.(options);
  let runtime = new AgentRuntime(options);
  cleanups.push(async () => {
    await runtime.shutdown();
    store.close();
  });
  return {
    root,
    config,
    store,
    requests,
    options,
    get runtime() {
      return runtime;
    },
    async restart() {
      await runtime.shutdown();
      runtime = new AgentRuntime(options);
      return runtime;
    },
  };
}

it('R01 retains task history, applicable skills and memory for direct and polite verification actions', async () => {
  const f = await fixture(
    async function* () {
      yield { type: 'done', text: 'Fixture response' };
    },
    (options) => {
      options.skills = new SkillRegistry();
      options.skills.registerInstruction({
        name: 'cedar',
        description: 'Read cedar files',
        triggers: ['file'],
        body: 'CEDAR_SKILL_RULE',
        enabled: true,
      });
    },
  );
  const { thread } = f.runtime.createSession('context');
  f.store.addMessage(thread.id, 'user', 'The file we discussed is CEDAR-417.txt.');
  f.store.storeMemory('cedar-memory', 'file CEDAR_MEMORY_RULE', [], {});
  for (const input of [
    'Read the file we just discussed.',
    'Can you read the file we just discussed?',
  ]) {
    await f.runtime.waitForRun(f.runtime.startRun({ threadId: thread.id, input }).id);
    const request = f.requests.at(-1);
    if (!request) throw new Error('Expected provider request');
    expect(request.messages.some((message) => message.content.includes('CEDAR-417.txt'))).toBe(
      true,
    );
    expect(request.systemPrompt).toContain('CEDAR_SKILL_RULE');
    expect(request.systemPrompt).toContain('CEDAR_MEMORY_RULE');
    expect(classifyVerificationPolicy(input)).toBe('workspace_state');
  }
  expect(classifyVerificationPolicy('Do you have access to read files?')).toBe('none');
  expect(classifyVerificationPolicy('Can you read files in general?')).toBe('none');
  expect(classifyVerificationPolicy('Can you read a file?')).toBe('none');
  expect(classifyVerificationPolicy('Could you please read the file we discussed?')).toBe(
    'workspace_state',
  );
});

it('R02 budgets every outgoing request and preserves complete tool-call/result groups', async () => {
  const f = await fixture(
    async function* (index) {
      if (index <= 6)
        yield {
          type: 'tool_call',
          id: `read-${index}`,
          name: 'workspace.read',
          arguments: { path: `large-${index}.txt` },
        };
      else yield { type: 'done', text: 'Inspected fixture.' };
    },
    ({ config }) => {
      config.limits.maxContextTokens = 12000;
      config.provider.contextWindow = 12000;
      config.limits.contextResponseReserveTokens = 512;
      config.limits.maxContextSummaryTokens = 256;
    },
  );
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      writeFile(join(f.root, `large-${index + 1}.txt`), 'x'.repeat(75000)),
    ),
  );
  const { thread } = f.runtime.createSession('budget');
  const result = await f.runtime.waitForRun(
    f.runtime.startRun({ threadId: thread.id, input: 'Summarize the fixture.' }).id,
  );
  expect(f.requests.length).toBeGreaterThan(2);
  for (const request of f.requests) {
    const tokens =
      estimateMessageTokens({ role: 'system', content: request.systemPrompt ?? '' }) +
      estimateToolSchemaTokens(request.tools ?? []) +
      request.messages.reduce((n, m) => n + estimateMessageTokens(m), 0) +
      512;
    expect(tokens).toBeLessThanOrEqual(12000);
    for (const [index, message] of request.messages.entries()) {
      if (message.toolCalls?.length)
        expect(
          request.messages
            .slice(index + 1, index + 1 + message.toolCalls.length)
            .map((m) => m.toolCallId),
        ).toEqual(message.toolCalls.map((c) => c.id));
      if (message.role === 'tool')
        expect(
          request.messages
            .slice(0, index)
            .some((m) => m.toolCalls?.some((c) => c.id === message.toolCallId)),
        ).toBe(true);
    }
  }
  expect(
    result.status === 'completed' ||
      (result.status === 'failed' && /context.*budget/i.test(result.output)),
  ).toBe(true);
});

it('R03 restart/retry retains images and intersects original authority with current policy', async () => {
  const f = await fixture(
    async function* (index) {
      if (index === 1) throw new Error('Controlled provider failure');
      yield { type: 'done', text: 'Image described.' };
    },
    (options) => {
      options.resolvePermissions = () => permissionContextForProfile('operator');
    },
  );
  const { thread } = f.runtime.createSession('recovery');
  const images = [{ name: 'cedar.png', mimeType: 'image/png', data: 'Y2VkYXI=' }];
  const original = f.runtime.startRun({
    threadId: thread.id,
    input: 'Describe the image.',
    images,
    permissions: permissionContextForProfile('operator'),
    permissionSource: 'web',
  });
  expect((await f.runtime.waitForRun(original.id)).status).toBe('failed');
  await f.restart();
  await f.runtime.waitForRun(f.runtime.resumeRun(original.id).id);
  expect(f.requests.at(-1)?.messages.flatMap((m) => m.images ?? [])).toEqual(images);
  expect(f.requests.at(-1)?.tools?.some((t) => t.name === 'workspace.write')).toBe(true);
  f.options.resolvePermissions = () => permissionContextForProfile('read-only');
  await f.runtime.waitForRun(f.runtime.resumeRun(original.id).id);
  expect(f.requests.at(-1)?.tools?.some((t) => t.name === 'workspace.write')).toBe(false);
  expect(f.requests.at(-1)?.messages.flatMap((m) => m.images ?? [])).toEqual(images);
  f.options.resolvePermissions = undefined;
  expect(() => f.runtime.resumeRun(original.id)).toThrow(/authority|authoriz/i);
});

it('R03 fails a persisted approved run safely when current authority cannot be recovered', async () => {
  const f = await fixture(async function* () {
    yield {
      type: 'tool_call',
      id: 'write',
      name: 'workspace.write',
      arguments: { path: 'pending.txt', content: 'not executed' },
    };
  });
  const { thread } = f.runtime.createSession('pending recovery');
  const run = f.runtime.startRun({
    threadId: thread.id,
    input: 'Write pending.txt.',
    permissions: permissionContextForProfile('operator'),
    permissionSource: 'web',
  });
  for (let attempt = 0; attempt < 100 && !f.runtime.listApprovals('pending').length; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const approval = f.runtime.listApprovals('pending')[0];
  if (!approval) throw new Error('Expected pending approval');
  await f.runtime.shutdown();
  f.store.decideApprovalRequest(approval.id, 'approved', Date.now(), approval.payloadHash);
  await f.restart();
  expect(f.store.getRun(run.id)?.status).toBe('failed');
  expect(f.store.getRun(run.id)?.output).toMatch(/authoriz|authority/i);
});

it('R04 accepts a target read and preserves greeting-only no-tool behavior', async () => {
  const f = await fixture(async function* (index) {
    if (index === 1)
      yield {
        type: 'tool_call',
        id: 'read',
        name: 'workspace.read',
        arguments: { path: 'target.txt' },
      };
    else yield { type: 'done', text: index === 2 ? 'Target content is cedar.' : 'Hello.' };
  });
  await writeFile(join(f.root, 'target.txt'), 'cedar');
  const { thread } = f.runtime.createSession('positive evidence');
  const read = await f.runtime.waitForRun(
    f.runtime.startRun({ threadId: thread.id, input: 'Read target.txt.' }).id,
  );
  expect(read).toMatchObject({ status: 'completed', output: 'Target content is cedar.' });
  const greeting = await f.runtime.waitForRun(
    f.runtime.startRun({ threadId: thread.id, input: 'Hello!' }).id,
  );
  expect(greeting).toMatchObject({ status: 'completed', output: 'Hello.' });
  expect(
    f.store
      .listEvents()
      .filter((event) => event.runId === greeting.id && event.type === 'tool.started'),
  ).toEqual([]);
});

it('R04 requires and accepts exact readback after an authorized write', async () => {
  const f = await fixture(async function* (index) {
    if (index === 1)
      yield {
        type: 'tool_call',
        id: 'write',
        name: 'workspace.write',
        arguments: { path: 'target.txt', content: 'cedar' },
      };
    else if (index === 2)
      yield {
        type: 'tool_call',
        id: 'read',
        name: 'workspace.read',
        arguments: { path: 'target.txt' },
      };
    else yield { type: 'done', text: 'Wrote and read back cedar.' };
  });
  const { thread } = f.runtime.createSession('write evidence');
  const run = f.runtime.startRun({
    threadId: thread.id,
    input: 'Write target.txt with cedar.',
    permissions: permissionContextForProfile('operator'),
  });
  for (let attempt = 0; attempt < 100 && !f.runtime.listApprovals('pending').length; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const approval = f.runtime.listApprovals('pending')[0];
  if (!approval) throw new Error('Expected write approval');
  f.runtime.approveApproval(approval.id, approval.payloadHash);
  expect(await f.runtime.waitForRun(run.id)).toMatchObject({
    status: 'completed',
    output: 'Wrote and read back cedar.',
  });
});

it.each([
  ['What is the current weather in Springtown?', 'workspace.list', {}],
  ['Read target.txt and report its contents.', 'workspace.list', {}],
  ['Read target.txt.', 'workspace.read', { path: 'other.txt' }],
  ['Read target.txt and report its contents.', 'workspace.read', { path: 'other.txt' }],
  [
    'Read other.txt and target.txt and report their contents.',
    'workspace.read',
    { path: 'other.txt' },
  ],
  ['Write target.txt with hello.', 'workspace.read', { path: 'other.txt' }],
])('R04 unrelated successful evidence cannot complete %s', async (input, name, args) => {
  const f = await fixture(async function* (index) {
    if (index === 1) yield { type: 'tool_call', id: 'unrelated', name, arguments: args };
    else yield { type: 'done', text: 'AUDIT_UNSUPPORTED_COMPLETION' };
  });
  await writeFile(join(f.root, 'other.txt'), 'Unrelated real file.');
  const { thread } = f.runtime.createSession('evidence');
  const result = await f.runtime.waitForRun(f.runtime.startRun({ threadId: thread.id, input }).id);
  expect(result.status).toBe('failed');
  expect(result.output).toMatch(/relevant.*evidence|evidence.*relevant/i);
  expect(result.output).not.toContain('AUDIT_UNSUPPORTED_COMPLETION');
});
