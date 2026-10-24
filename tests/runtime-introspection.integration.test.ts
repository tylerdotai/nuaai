import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { createEvent } from '../src/core/events.js';
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
    await expect(
      tools.execute('runtime.inspect', { section: 'observation' }, context),
    ).rejects.toThrow('observation requires the recorded callId');
    await expect(
      tools.execute('runtime.inspect', {}, { ...context, runId: undefined }),
    ).rejects.toThrow('matching run/thread binding');
    await expect(
      tools.execute('runtime.inspect', {}, { ...context, runId: 'missing-run' }),
    ).rejects.toThrow('matching run/thread binding');
    await expect(
      tools.execute('runtime.inspect', {}, { ...context, root: join(root, 'other-workspace') }),
    ).rejects.toThrow('workspace binding');

    const pending = store.createRun(
      created.thread.id,
      'Not yet admitted',
      'capture',
      'capture',
      'pending',
      100,
    );
    const pendingContext = { ...context, runId: pending.id };
    await expect(tools.execute('runtime.inspect', {}, pendingContext)).rejects.toThrow(
      'workspace binding',
    );
    const execution = store.getRunExecutionContext(run.id);
    if (!execution) throw new Error('Completed run must retain its admitted execution context');
    store.saveRunExecutionContext(pending.id, execution);
    expect(
      await tools.execute('runtime.inspect', { section: 'context' }, pendingContext),
    ).toMatchObject({
      maxContextUnits: defaultRuntimeConfig(root).limits.maxContextTokens,
      selection: null,
      latestCheckpoint: null,
      estimated: true,
    });
    expect(await tools.execute('runtime.inspect', {}, pendingContext)).toMatchObject({
      lastFailure: null,
      learning: { recentEvents: [] },
    });
    expect(
      await tools.execute('runtime.inspect', { section: 'capabilities' }, context),
    ).toMatchObject({
      tools: expect.arrayContaining(['workspace.read', 'runtime.inspect']),
      permissions: ['read'],
    });

    const append = (type: Parameters<typeof createEvent>[0], payload: Record<string, unknown>) =>
      store.appendEvent(createEvent(type, payload, { runId: run.id, threadId: created.thread.id }));
    append('context.selected', { maxContextUnits: 1234, selectedMessageCount: 2, phase: 'active' });
    append('context.compacted', { phase: 'active', archivedCallCount: 1 });
    expect(await tools.execute('runtime.inspect', { section: 'context' }, context)).toMatchObject({
      maxContextUnits: 1234,
      selection: { maxContextUnits: 1234, selectedMessageCount: 2, phase: 'active' },
      latestCheckpoint: { phase: 'active', archivedCallCount: 1 },
    });

    append('knowledge.review.failed', { error: `token sk-${'a'.repeat(40)} ${'x'.repeat(600)}` });
    append('memory.stored', {
      saved: 1,
      proposed: 2,
      rejectedReasons: ['outside scope'],
      taskId: 'task-fixture',
    });
    expect(await tools.execute('runtime.inspect', { section: 'learning' }, context)).toMatchObject({
      recentEvents: [
        {
          type: 'memory.retrieved',
          saved: null,
          proposed: null,
          rejectedReasons: null,
          taskId: null,
          error: null,
        },
        {
          type: 'knowledge.review.failed',
          saved: null,
          proposed: null,
          rejectedReasons: null,
          taskId: null,
          error: expect.any(String),
        },
        {
          type: 'memory.stored',
          saved: 1,
          proposed: 2,
          rejectedReasons: ['outside scope'],
          taskId: 'task-fixture',
          error: null,
        },
      ],
    });
    const learning = JSON.stringify(
      await tools.execute('runtime.inspect', { section: 'learning' }, context),
    );
    expect(learning).not.toContain(`sk-${'a'.repeat(40)}`);
    expect(learning).not.toContain('x'.repeat(501));

    const firstFailure = append('tool.failed', {
      name: 'workspace.read',
      error: 'Read failed',
      failureCode: 'READ_FAILED',
      executionState: 'not_executed',
      recovery: 'choose_alternative',
    });
    expect(await tools.execute('runtime.inspect', {}, context)).toMatchObject({
      lastFailure: {
        eventId: firstFailure.id,
        type: 'tool.failed',
        details: { tool: 'workspace.read', error: 'Read failed' },
        failureCode: 'READ_FAILED',
        executionState: 'not_executed',
        recovery: 'choose_alternative',
        retrySafety: 'follow_recorded_recovery_not_blind_repetition',
      },
    });
    const newerFailure = append('run.failed', {
      error: 'Outcome uncertain',
      executionState: 'uncertain',
    });
    expect(await tools.execute('runtime.inspect', {}, context)).toMatchObject({
      lastFailure: {
        eventId: newerFailure.id,
        type: 'run.failed',
        details: { tool: null, error: 'Outcome uncertain' },
        failureCode: null,
        recovery: 'unknown',
        retrySafety: 'do_not_retry_automatically',
      },
    });
    const unknownFailure = append('tool.failed', { error: 42 });
    expect(await tools.execute('runtime.inspect', {}, context)).toMatchObject({
      lastFailure: {
        eventId: unknownFailure.id,
        details: { tool: null, error: null },
        failureCode: null,
        executionState: 'unknown',
        recovery: 'unknown',
        retrySafety: 'unknown',
      },
    });
  } finally {
    await runtime.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
