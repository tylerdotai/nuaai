import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultRuntimeConfig, parseRuntimeConfig } from '../src/config/index.js';
import {
  type ContextMessage,
  estimateMessageTokens,
  estimateTokens,
  selectContextMessages,
} from '../src/core/context.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderRequest,
  ProviderStreamEvent,
} from '../src/providers/types.js';
import { ToolRegistry } from '../src/tools/registry.js';

const stores: DatabaseStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function makeStore(): Promise<{ root: string; store: DatabaseStore }> {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-context-'));
  const store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  return { root, store };
}

function provider(
  requests: ProviderRequest[],
  behavior: (request: ProviderRequest) => AsyncIterable<ProviderStreamEvent> = async function* () {
    yield { type: 'done', text: 'done' };
  },
): ProviderAdapter {
  return {
    name: 'capture',
    model: 'capture-model',
    async *stream(request) {
      requests.push(request);
      yield* behavior(request);
    },
    embed: async () => [],
    health: async (): Promise<ProviderHealth> => ({
      name: 'capture',
      available: true,
      detail: 'test',
    }),
  };
}

function providers(adapter: ProviderAdapter) {
  return {
    get: () => adapter,
    list: () => [adapter.name],
    health: async () => [await adapter.health()],
  } as never;
}

describe('token-aware context selection', () => {
  it('migrates the legacy byte budget to a conservative token budget', () => {
    const config = parseRuntimeConfig({ limits: { maxContextBytes: 30_000 } }, '/tmp/project');
    expect(config.limits.maxContextTokens).toBe(10_000);
  });

  it('keeps an older message at the exact token boundary and drops it one token over', () => {
    const older: ContextMessage = { id: 'older', role: 'assistant', content: 'older response' };
    const current: ContextMessage = { id: 'current', role: 'user', content: 'current input' };
    const exactBudget = estimateMessageTokens(older) + estimateMessageTokens(current);

    expect(
      selectContextMessages([older, current], {
        maxTokens: exactBudget,
        currentMessageId: current.id,
      }).messages.map((message) => message.id),
    ).toEqual(['older', 'current']);
    expect(
      selectContextMessages([older, current], {
        maxTokens: exactBudget - 1,
        currentMessageId: current.id,
      }).messages.map((message) => message.id),
    ).toEqual(['current']);
  });

  it('estimates multibyte text deterministically without splitting it', () => {
    const value = '事实🙂 café';
    expect(estimateTokens(value)).toBe(estimateTokens(value));
    expect(estimateTokens(value)).toBeGreaterThan(0);
    expect(Buffer.from(value, 'utf8').toString('utf8')).toBe(value);
  });

  it('preserves an oversized current input and reports the budget overage', () => {
    const current: ContextMessage = { id: 'current', role: 'user', content: '🙂'.repeat(200) };
    const selected = selectContextMessages([current], {
      maxTokens: 1,
      currentMessageId: current.id,
    });

    expect(selected.messages).toEqual([current]);
    expect(selected.overBudget).toBe(true);
    expect(selected.estimatedTokens).toBeGreaterThan(selected.maxTokens);
  });

  it('keeps or drops an assistant tool call and every matching result atomically', () => {
    const call: ContextMessage = {
      id: 'call',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tool-1', name: 'workspace.read', arguments: { path: 'README.md' } }],
    };
    const result: ContextMessage = {
      id: 'result',
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'tool-1',
      toolName: 'workspace.read',
    };
    const current: ContextMessage = { id: 'current', role: 'user', content: 'continue' };
    const pairTokens = estimateMessageTokens(call) + estimateMessageTokens(result);
    const currentTokens = estimateMessageTokens(current);

    expect(
      selectContextMessages([call, result, current], {
        maxTokens: pairTokens + currentTokens,
        currentMessageId: current.id,
      }).messages.map((message) => message.id),
    ).toEqual(['call', 'result', 'current']);
    expect(
      selectContextMessages([call, result, current], {
        maxTokens: pairTokens + currentTokens - 1,
        currentMessageId: current.id,
      }).messages.map((message) => message.id),
    ).toEqual(['current']);
  });

  it('preserves pinned system constraints even when recent context consumes the budget', () => {
    const constraint: ContextMessage = {
      id: 'constraint',
      role: 'system',
      content: 'Never publish without approval.',
      pinned: true,
    };
    const current: ContextMessage = { id: 'current', role: 'user', content: 'continue' };
    const selected = selectContextMessages([constraint, current], {
      maxTokens: estimateMessageTokens(current),
      currentMessageId: current.id,
    });

    expect(selected.messages.map((message) => message.id)).toEqual(['constraint', 'current']);
    expect(selected.overBudget).toBe(true);
  });

  it('removes orphan tool results and incomplete tool-call groups', () => {
    const incomplete: ContextMessage = {
      id: 'incomplete',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'missing', name: 'workspace.read', arguments: {} }],
    };
    const orphan: ContextMessage = {
      id: 'orphan',
      role: 'tool',
      content: '{}',
      toolCallId: 'other',
      toolName: 'workspace.read',
    };
    const current: ContextMessage = { id: 'current', role: 'user', content: 'continue' };

    const selected = selectContextMessages([incomplete, orphan, current], {
      maxTokens: 10_000,
      currentMessageId: current.id,
    });
    expect(selected.messages).toEqual([current]);
    expect(selected.droppedMessageCount).toBe(2);
  });
});

describe('durable compaction checkpoints', () => {
  it('is rolling, idempotent, bounded, and records source provenance', async () => {
    const { store } = await makeStore();
    const created = store.createSession('checkpoint');
    const first = store.addMessage(
      created.thread.id,
      'user',
      'Always keep the pinned fact: café 🙂.',
    );
    store.storeMessageArtifact(first.id, 'context_pin', { pinned: true });
    store.addMessage(created.thread.id, 'assistant', 'acknowledged');
    const third = store.addMessage(created.thread.id, 'user', 'ordinary older detail');

    const checkpoint = store.compactThreadThrough(created.thread.id, third.id, 120);
    expect(checkpoint).toMatchObject({
      sourceStartMessageId: first.id,
      sourceEndMessageId: third.id,
      sourceMessageCount: 3,
      version: 1,
      sourceProvenance: 'sha256:canonical-message-v1',
    });
    expect(checkpoint.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.estimatedOriginalTokens).toBeGreaterThan(0);
    expect(checkpoint.estimatedSummaryTokens).toBeLessThanOrEqual(120);
    expect(checkpoint.summary).toContain('café 🙂');
    expect(checkpoint.summary).not.toContain('�');

    const unchanged = store.compactThreadThrough(created.thread.id, third.id, 120);
    expect(unchanged).toEqual(checkpoint);

    const fourth = store.addMessage(created.thread.id, 'assistant', 'new compacted record');
    const rolled = store.compactThreadThrough(created.thread.id, fourth.id, 120);
    expect(rolled.version).toBe(2);
    expect(rolled.sourceStartMessageId).toBe(first.id);
    expect(rolled.sourceEndMessageId).toBe(fourth.id);
    expect(rolled.sourceMessageCount).toBe(4);
    expect(rolled.summary).toContain('café 🙂');
    expect(rolled.sourceSha256).not.toBe(checkpoint.sourceSha256);
    expect(store.listMessages(created.thread.id, 100)).toHaveLength(4);
  });

  it('selects identical structured context after reopening the database', async () => {
    const { root, store } = await makeStore();
    const created = store.createSession('restart');
    const user = store.addMessage(created.thread.id, 'user', 'inspect');
    const assistant = store.addMessage(created.thread.id, 'assistant', '');
    store.storeMessageArtifact(assistant.id, 'tool_calls', {
      calls: [{ id: 'call-1', name: 'workspace.read', arguments: { path: 'README.md' } }],
    });
    const tool = store.addMessage(created.thread.id, 'tool', '{"value":1}');
    store.storeMessageArtifact(tool.id, 'tool_result', {
      callId: 'call-1',
      name: 'workspace.read',
      result: { value: 1 },
    });
    const current = store.addMessage(created.thread.id, 'user', 'continue');
    store.compactThreadThrough(created.thread.id, user.id, 120);

    const before = selectContextMessages(
      store.listStructuredMessagesThrough(created.thread.id, current.id),
      { maxTokens: 10_000, currentMessageId: current.id },
    );
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new DatabaseStore(openAppDatabase(root));
    stores.push(reopened);
    const after = selectContextMessages(
      reopened.listStructuredMessagesThrough(created.thread.id, current.id),
      { maxTokens: 10_000, currentMessageId: current.id },
    );

    expect(after).toEqual(before);
  });
});

describe('runtime context contract', () => {
  it('replays durable tool calls and matching results as structured provider messages', async () => {
    const { root, store } = await makeStore();
    const requests: ProviderRequest[] = [];
    const adapter = provider(requests);
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providers(adapter),
      tools: new ToolRegistry(root),
    });
    expect(runtime.status().context).toEqual({
      estimator: 'utf8-bytes-per-3-v1',
      maxTokens: 131_072,
      responseReserveTokens: 8_192,
      maxSummaryTokens: 4_096,
    });
    const created = runtime.createSession('structured history');
    store.addMessage(created.thread.id, 'user', 'read it');
    const assistant = store.addMessage(created.thread.id, 'assistant', 'checking');
    store.storeMessageArtifact(assistant.id, 'tool_calls', {
      calls: [{ id: 'call-1', name: 'workspace.read', arguments: { path: 'README.md' } }],
    });
    const tool = store.addMessage(created.thread.id, 'tool', '{"ok":true}');
    store.storeMessageArtifact(tool.id, 'tool_result', {
      callId: 'call-1',
      name: 'workspace.read',
      result: { ok: true },
    });
    store.addMessage(created.thread.id, 'assistant', 'finished');

    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'continue',
      provider: 'capture',
    });
    await runtime.waitForRun(run.id);

    expect(requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'checking',
          toolCalls: [{ id: 'call-1', name: 'workspace.read', arguments: { path: 'README.md' } }],
        }),
        expect.objectContaining({
          role: 'tool',
          content: '{"ok":true}',
          toolCallId: 'call-1',
          toolName: 'workspace.read',
        }),
      ]),
    );
  });

  it('emits content-free compaction and selection metrics and preserves pinned memory', async () => {
    const { root, store } = await makeStore();
    const requests: ProviderRequest[] = [];
    const adapter = provider(requests);
    const config = defaultRuntimeConfig(root);
    config.limits.maxContextTokens = 300;
    config.limits.maxContextSummaryTokens = 80;
    config.limits.contextResponseReserveTokens = 50;
    const runtime = new AgentRuntime({
      root,
      config,
      store,
      providers: providers(adapter),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('metrics');
    store.updateSessionContext(created.session.id, 'Never change the project constraint.');
    store.storeMemory('pinned-1', 'Pinned fact survives every selection.', null, { pinned: true });
    for (let index = 0; index < 8; index += 1) {
      store.addMessage(created.thread.id, 'user', `old user ${index} ${'x'.repeat(80)}`);
      store.addMessage(created.thread.id, 'assistant', `old answer ${index} ${'y'.repeat(80)}`);
    }

    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'continue',
      provider: 'capture',
    });
    await runtime.waitForRun(run.id);

    expect(requests[0]?.systemPrompt).toContain('Never change the project constraint.');
    expect(requests[0]?.systemPrompt).toContain('Pinned fact survives every selection.');
    const events = store.listEvents().filter((event) => event.runId === run.id);
    const compacted = events.find((event) => event.type === 'context.compacted');
    const selected = events.find((event) => event.type === 'context.selected');
    expect(compacted?.payload).toMatchObject({
      sourceMessageCount: expect.any(Number),
      originalContextUnits: expect.any(Number),
      summaryContextUnits: expect.any(Number),
    });
    expect(selected?.payload).toMatchObject({
      selectedMessageCount: expect.any(Number),
      droppedMessageCount: expect.any(Number),
      estimatedContextUnits: expect.any(Number),
      maxContextUnits: 300,
      overBudget: expect.any(Boolean),
    });
    for (const event of [compacted, selected]) {
      expect(event?.payload).not.toHaveProperty('content');
      expect(JSON.stringify(event?.payload)).not.toContain('Pinned fact survives');
      expect(JSON.stringify(event?.payload)).not.toContain('old user');
    }
    expect(store.listMessages(created.thread.id, 100)).toHaveLength(18);
  });
});
