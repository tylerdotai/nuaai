import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { realTuiHarness } from './tui.real-harness.js';

it('lets a real TUI run explain unavailable dispatch after agent.list and skill.load without claiming a subagent ran', async () => {
  const h = await realTuiHarness();
  const provider = vi
    .spyOn(DeterministicProvider.prototype, 'stream')
    .mockImplementation(async function* (request) {
      if (!request.messages.some((message) => message.toolName === 'agent.list'))
        yield { type: 'tool_call' as const, id: 'list', name: 'agent.list', arguments: {} };
      else if (!request.messages.some((message) => message.toolName === 'skill.load'))
        yield {
          type: 'tool_call' as const,
          id: 'load',
          name: 'skill.load',
          arguments: { name: 'agent-dispatch' },
        };
      else
        yield {
          type: 'done' as const,
          text: 'Subagent dispatch is unavailable: no adapters are configured. No subagent was launched.',
        };
    });
  try {
    await h.command('/new Unavailable dispatch regression', 'Unavailable dispatch regression');
    const before = new Set(
      h.daemon.store
        .listSessions()
        .flatMap((session) => h.daemon.store.listThreads(session.id))
        .flatMap((thread) => h.daemon.store.listRuns(thread.id).map((run) => run.id)),
    );
    await h.send('Try agent dispatch for subagents', 'Try agent dispatch for subagents');
    await h.send('\r');
    let id = '';
    await expect
      .poll(() => {
        const session = h.daemon.store
          .listSessions()
          .find((s) => s.title === 'Unavailable dispatch regression');
        if (!session) return false;
        const run = h.daemon.store
          .listThreads(session.id)
          .flatMap((t) => h.daemon.store.listRuns(t.id))
          .find((r) => !before.has(r.id));
        id = run?.id ?? '';
        return Boolean(id);
      })
      .toBe(true);
    const result = await h.daemon.runtime.waitForRun(id);
    expect(result.status, result.output).toBe('completed');
    await expect.poll(h.frame).toContain('No subagent was launched.');
    expect(h.frame()).not.toContain('could not verify completion');
    const events = h.daemon.store.listEvents().filter((event) => event.runId === id);
    expect(events.filter((event) => event.type === 'tool.failed')).toEqual([]);
    const loaded = events.find(
      (event) => event.type === 'tool.completed' && event.payload.name === 'skill.load',
    );
    expect(loaded?.payload.result).toMatchObject({
      loaded: false,
      name: 'agent-dispatch',
      reason: 'missing_tools',
      unavailableTools: ['agent.dispatch'],
    });
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
  } finally {
    provider.mockRestore();
    await h.close();
  }
}, 20000);
