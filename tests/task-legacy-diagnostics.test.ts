import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('recovers uniquely linked legacy background failures but refuses to guess between multiple matching runs', async () => {
  const h = await identityHarness(async () => {
    throw new Error('LEGACY_RECORDED_FAILURE');
  });
  try {
    const input = 'Legacy child diagnostic fixture.';
    const task = h.daemon.store.createTask(
      'background.run',
      { agentInput: input, attempts: 1, error: 'Agent run ended with status: failed' },
      null,
    );
    const session = h.daemon.runtime.getOrCreateSession(
      `schedule:task:${task.id}`,
      'Legacy background task',
    );
    const fail = async () => {
      const accepted = await h.api('/api/runs', { threadId: session.thread.id, input });
      await h.daemon.runtime.waitForRun(accepted.body.id);
      h.daemon.store.updateTask(task.id, 'failed', task.payload);
      return accepted.body.id as string;
    };
    const runId = await fail();
    const unique = await h.api(`/api/tasks/${task.id}`);
    expect(unique.body).toMatchObject({
      linkage: 'legacy_unique_task_session',
      execution: { runId },
      failure: { message: expect.stringContaining('LEGACY_RECORDED_FAILURE') },
    });
    await fail();
    const ambiguous = await h.api(`/api/tasks/${task.id}`);
    expect(ambiguous.body.linkage).toBe('ambiguous');
    expect(ambiguous.body.execution).toBeUndefined();
    expect(JSON.stringify(ambiguous.body)).not.toContain('LEGACY_RECORDED_FAILURE');
  } finally {
    await h.close();
  }
});
