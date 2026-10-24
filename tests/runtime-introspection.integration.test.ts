import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import type { ProviderRequest } from '../src/providers/types.js';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';

it('exposes truthful bound-run diagnostics and archived observations without crossing thread/workspace or permission boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-introspection-'));
  const store = new DatabaseStore(openAppDatabase(root));
  await writeFile(join(root, 'own.txt'), 'OWN_SCOPE_MARKER');
  const tools = new ToolRegistry(root);
  const adapter = {
    name: 'capture',
    model: 'capture',
    embed: async () => [],
    async *stream(request: ProviderRequest) {
      if (!request.messages.some((message) => message.toolName === 'workspace.read'))
        yield {
          type: 'tool_call' as const,
          id: 'own-read',
          name: 'workspace.read',
          arguments: { path: 'own.txt' },
        };
      else yield { type: 'done' as const, text: 'own.txt contains OWN_SCOPE_MARKER.' };
    },
  };
  const runtime = new AgentRuntime({
    root,
    store,
    config: defaultRuntimeConfig(root),
    tools,
    providers: { get: () => adapter, list: () => ['capture'] } as never,
  });
  try {
    const created = runtime.createSession('Inspect own execution');
    const run = runtime.startRun({
      threadId: created.thread.id,
      provider: 'capture',
      input: 'Read own.txt and report its marker.',
    });
    expect((await runtime.waitForRun(run.id)).status).toBe('completed');
    const context = {
      root,
      runId: run.id,
      threadId: created.thread.id,
      permissions: permissionContextForProfile('read-only'),
    };
    const snapshot = (await tools.execute('runtime.inspect', {}, context)) as {
      run: { id: string; status: string };
      capabilities: { tools: string[] };
      context: { maxContextUnits: number };
    };
    expect(snapshot.run).toMatchObject({ id: run.id, status: 'completed' });
    expect(snapshot.capabilities.tools).toContain('workspace.read');
    expect(snapshot.capabilities.tools).not.toContain('host.command');
    expect(snapshot.context.maxContextUnits).toBe(
      defaultRuntimeConfig(root).limits.maxContextTokens,
    );
    const references = await tools.execute('runtime.inspect', { section: 'observations' }, context);
    expect(JSON.stringify(references)).toContain('own-read');
    const observation = await tools.execute(
      'runtime.inspect',
      { section: 'observation', callId: 'own-read' },
      context,
    );
    expect(JSON.stringify(observation)).toContain('OWN_SCOPE_MARKER');
    const other = runtime.createSession('Different thread');
    await expect(
      tools.execute('runtime.inspect', {}, { ...context, threadId: other.thread.id }),
    ).rejects.toThrow('binding');
    await expect(tools.execute('runtime.inspect', { runId: run.id }, context)).rejects.toThrow();
    await expect(
      tools.execute('runtime.inspect', { section: 'observation', callId: 'missing-call' }, context),
    ).rejects.toThrow('not found');
  } finally {
    await runtime.shutdown();
    store.close();
  }
}, 15_000);
