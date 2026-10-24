import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { decodeToolArguments } from '../src/core/tool-input.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { ToolRegistry } from '../src/tools/registry.js';

it('records a bounded repair-exhausted failure instead of paying for repeated identical malformed requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-repair-exhaustion-'));
  const store = new DatabaseStore(openAppDatabase(root));
  let requests = 0;
  const provider = {
    name: 'capture',
    model: 'capture',
    embed: async () => [],
    async *stream() {
      requests += 1;
      yield {
        type: 'tool_call' as const,
        id: `invalid-${requests}`,
        name: 'workspace.list',
        arguments: decodeToolArguments('{broken'),
      };
    },
  };
  const runtime = new AgentRuntime({
    root,
    store,
    config: defaultRuntimeConfig(root),
    tools: new ToolRegistry(root),
    providers: { get: () => provider, list: () => ['capture'] } as never,
  });
  try {
    const created = runtime.createSession('Malformed repetition');
    const run = runtime.startRun({
      threadId: created.thread.id,
      provider: 'capture',
      input: 'List the workspace.',
    });
    const result = await runtime.waitForRun(run.id);
    expect(result.status).toBe('failed');
    expect(requests).toBe(3);
    expect(result.output).toContain('repeated identical non-execution rejections');
    expect(
      store.listRecentEventsForRun(run.id, 100).filter((event) => event.type === 'tool.completed'),
    ).toHaveLength(0);
  } finally {
    await runtime.shutdown();
    store.close();
  }
}, 15_000);
