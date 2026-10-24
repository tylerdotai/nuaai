import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { assertRequestContextBudget } from '../src/core/context.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import type { ProviderRequest } from '../src/providers/types.js';
import { ToolRegistry } from '../src/tools/registry.js';

it('repeatedly compacts active tool execution before transport while retaining the goal, constraints and full durable observations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-active-context-'));
  const store = new DatabaseStore(openAppDatabase(root));
  const files = Array.from({ length: 6 }, (_, index) => `source-${index}.txt`);
  for (const file of files)
    await writeFile(join(root, file), `MARKER:${file}\n${'source evidence '.repeat(800)}`);
  const requests: Array<Pick<ProviderRequest, 'messages' | 'systemPrompt' | 'tools'>> = [];
  let step = 0;
  const adapter = {
    name: 'capture',
    model: 'capture-model',
    embed: async () => [],
    health: async () => ({ name: 'capture', available: true, detail: 'Isolated context fixture' }),
    async *stream(request: ProviderRequest) {
      requests.push({
        messages: structuredClone(request.messages),
        systemPrompt: request.systemPrompt,
        tools: structuredClone(request.tools),
      });
      const file = files[step];
      step += 1;
      if (file)
        yield {
          type: 'tool_call' as const,
          id: `read-${step}`,
          name: 'workspace.read',
          arguments: { path: file },
        };
      else
        yield {
          type: 'done' as const,
          text: `All ${files.length} listed files were read. Final marker: MARKER:${files.at(-1)}.`,
        };
    },
  };
  const config = defaultRuntimeConfig(root);
  config.limits.maxContextTokens = 12000;
  config.limits.contextResponseReserveTokens = 256;
  config.limits.maxContextSummaryTokens = 700;
  const runtime = new AgentRuntime({
    root,
    store,
    config,
    providers: { get: () => adapter, list: () => [adapter.name] } as never,
    tools: new ToolRegistry(root),
  });
  try {
    const created = runtime.createSession('Active execution');
    const constraint =
      'No email sends, no policy changes, and preserve the complete requested scope.';
    store.updateSessionContext(created.session.id, constraint);
    const input = `Read each of ${files.join(', ')} and report its markers. Complete every listed read, not a subset.`;
    const run = runtime.startRun({ threadId: created.thread.id, provider: 'capture', input });
    const result = await runtime.waitForRun(run.id);
    expect(result.status, result.output ?? undefined).toBe('completed');
    expect(requests).toHaveLength(files.length + 1);
    for (const request of requests) {
      expect(() =>
        assertRequestContextBudget(
          request,
          config.limits.maxContextTokens,
          config.limits.contextResponseReserveTokens,
        ),
      ).not.toThrow();
      expect(request.systemPrompt).toContain(constraint);
      expect(request.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'user', content: input })]),
      );
    }
    const events = store
      .listEvents()
      .filter(
        (event) =>
          event.runId === run.id &&
          event.type === 'context.compacted' &&
          event.payload.phase === 'active',
      );
    expect(events.length).toBeGreaterThan(1);
    const retained = store
      .listMessages(created.thread.id, 100)
      .filter((message) => message.role === 'tool');
    expect(retained).toHaveLength(files.length);
    for (const file of files)
      expect(retained.some((message) => message.content.includes(`MARKER:${file}`))).toBe(true);
  } finally {
    await runtime.shutdown();
    store.close();
  }
}, 15_000);
