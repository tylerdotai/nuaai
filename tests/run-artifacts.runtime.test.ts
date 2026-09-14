import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { RunArtifactRegistry } from '../src/artifacts/registry.js';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderStreamEvent,
} from '../src/providers/types.js';
import type { PermissionContext } from '../src/security/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { initWorkspace } from '../src/workspace/fs.js';

const stores: DatabaseStore[] = [];
const operator: PermissionContext = {
  approved: new Set(['read', 'write', 'execute']),
  capabilities: { filesystem: true, subprocess: true, network: true },
};

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function provider(toolName: string, argumentsValue: Record<string, unknown>): ProviderAdapter {
  return {
    name: 'deterministic',
    model: 'local-test',
    async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      if (!request.messages.some((message) => message.role === 'tool')) {
        yield { type: 'tool_call', id: 'call-1', name: toolName, arguments: argumentsValue };
        return;
      }
      yield { type: 'done', text: 'Artifact work completed.' };
    },
    embed: async () => [],
    health: async () => ({ name: 'deterministic', available: true, detail: 'ready' }),
  };
}

function providerRegistry(adapter: ProviderAdapter) {
  return {
    get: (_name: string) => adapter,
    list: () => [adapter.name],
    health: async () => [await adapter.health()],
  } as never;
}

async function runtimeFixture(
  adapter: ProviderAdapter,
  configureTools?: (tools: ToolRegistry) => void,
  limits: { maxContentBytes?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-artifact-runtime-'));
  await initWorkspace(root);
  const store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  const tools = new ToolRegistry(root);
  configureTools?.(tools);
  const artifacts = new RunArtifactRegistry(root, store, limits);
  const runtime = new AgentRuntime({
    root,
    config: {
      ...defaultRuntimeConfig(root),
      provider: {
        ...defaultRuntimeConfig(root).provider,
        name: 'deterministic',
        model: 'local-test',
      },
    },
    store,
    providers: providerRegistry(adapter),
    tools,
    artifacts,
  });
  const created = runtime.createSession('Artifact runtime');
  return { root, store, tools, runtime, thread: created.thread };
}

describe('tool artifact candidate extraction', () => {
  it('extracts explicit structured artifacts and practical workspace and web candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-artifact-candidates-'));
    await initWorkspace(root);
    const search = {
      search: async () => [],
      fetch: async () => ({ url: 'https://example.com/page', title: 'Page', text: 'body' }),
      open: async () => ({ url: 'https://example.com/open', title: 'Open', text: 'body' }),
    };
    const tools = new ToolRegistry(root, search as never, { browserEnabled: true });

    expect(
      tools.artifactCandidates(
        'custom.report',
        {},
        {
          ok: true,
          artifacts: [
            {
              kind: 'test-report',
              title: 'Tests',
              mimeType: 'application/json',
              content: '{"passed":true}',
              metadata: { suite: 'unit' },
            },
          ],
        },
      ),
    ).toEqual([
      {
        kind: 'test-report',
        title: 'Tests',
        mimeType: 'application/json',
        content: '{"passed":true}',
        metadata: { suite: 'unit' },
      },
    ]);
    expect(
      tools.artifactCandidates(
        'workspace.write',
        { path: 'output/result.txt', content: 'done' },
        { written: 'output/result.txt' },
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'file',
        title: 'result.txt',
        mimeType: 'text/plain',
        workspacePath: 'output/result.txt',
      }),
    ]);
    expect(
      tools.artifactCandidates('web.search', { query: 'source' }, [
        {
          title: 'Reference',
          url: 'https://example.com/reference',
          snippet: 'safe',
          source: 'searxng',
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: 'citation',
        title: 'Reference',
        mimeType: 'text/uri-list',
        externalUrl: 'https://example.com/reference',
        metadata: { source: 'searxng' },
      }),
    ]);
    expect(
      tools.artifactCandidates(
        'web.fetch',
        { url: 'https://example.com/page' },
        {
          url: 'https://example.com/page',
          title: 'Page',
          text: 'body',
        },
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'citation',
        title: 'Page',
        externalUrl: 'https://example.com/page',
      }),
    ]);
  });
});

describe('runtime artifact capture', () => {
  it('captures workspace.write output, emits artifact.created, and survives reopen', async () => {
    const adapter = provider('workspace.write', { path: 'build/result.txt', content: 'durable' });
    const { root, store, runtime, thread } = await runtimeFixture(adapter);
    const run = runtime.startRun({
      threadId: thread.id,
      input: 'write the result',
      permissions: operator,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({ status: 'completed' });
    const artifacts = store.listRunArtifacts(run.id);
    expect(artifacts).toEqual([
      expect.objectContaining({
        runId: run.id,
        threadId: thread.id,
        kind: 'file',
        title: 'result.txt',
        mimeType: 'text/plain',
        sourceTool: 'workspace.write',
      }),
    ]);
    expect(store.listEventsForThread(thread.id).events.map((event) => event.type)).toContain(
      'artifact.created',
    );
    expect(await readFile(join(root, 'build/result.txt'), 'utf8')).toBe('durable');

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new DatabaseStore(openAppDatabase(root));
    stores.push(reopened);
    expect(reopened.listRunArtifacts(run.id)).toEqual(artifacts);
  });

  it('captures explicit inline artifacts returned by registered tools', async () => {
    const adapter = provider('custom.report', {});
    const { store, runtime, thread } = await runtimeFixture(adapter, (tools) => {
      tools.register({
        name: 'custom.report',
        description: 'Return a structured report artifact',
        permission: 'read',
        governance: {
          owner: 'test',
          costClass: 'low',
          authMode: 'none',
          sideEffects: 'none',
          approval: 'none',
          maxCallsPerRun: 1,
        },
        parameters: { type: 'object', properties: {} },
        input: z.object({}),
        execute: async () => ({
          artifacts: [
            {
              kind: 'diff',
              title: 'Changes',
              mimeType: 'text/x-diff',
              content: '+ durable\n',
            },
          ],
        }),
      });
    });
    const run = runtime.startRun({
      threadId: thread.id,
      input: 'make report',
      permissions: operator,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({ status: 'completed' });
    expect(store.listRunArtifacts(run.id)).toEqual([
      expect.objectContaining({ kind: 'diff', title: 'Changes', sourceTool: 'custom.report' }),
    ]);
  });

  it('keeps a successful tool and run successful when optional artifact capture fails', async () => {
    const adapter = provider('workspace.write', { path: 'large.txt', content: 'too large' });
    const { store, runtime, thread } = await runtimeFixture(adapter, undefined, {
      maxContentBytes: 4,
    });
    const run = runtime.startRun({
      threadId: thread.id,
      input: 'write large file',
      permissions: operator,
    });

    const completed = await runtime.waitForRun(run.id);
    expect(completed.status).toBe('completed');
    expect(completed.output).toBe('Artifact work completed.');
    expect(store.listRunArtifacts(run.id)).toEqual([]);
    const events = store.listEventsForThread(thread.id).events;
    expect(events.map((event) => event.type)).toContain('artifact.failed');
    expect(events.map((event) => event.type)).toContain('tool.completed');
    expect(events.map((event) => event.type)).not.toContain('tool.failed');
  });
});
