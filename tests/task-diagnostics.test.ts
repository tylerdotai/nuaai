import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('preserves the actual child-run failure and durable task/run correlation through the real daemon', async () => {
  const h = await identityHarness(async () => {
    throw new Error('CHILD_PROVIDER_FAILURE api_key=fixture_diagnostic_secret');
  });
  try {
    const accepted = h.daemon.scheduler.createTask(
      'Respond with a fixture greeting.',
      'Failure diagnostics',
    );
    const id = accepted.id;
    await expect
      .poll(() => h.daemon.scheduler.listTasks().find((task) => task.id === id)?.status)
      .toBe('failed');
    const task = h.daemon.scheduler.listTasks().find((task) => task.id === id);
    expect(task?.payload.error).toContain('CHILD_PROVIDER_FAILURE');
    expect(JSON.stringify(task?.payload)).not.toContain('fixture_diagnostic_secret');
    const execution = task?.payload.execution as {
      runId: string;
      threadId: string;
      sessionId: string;
      correlationId: string;
    };
    const run = h.daemon.store.getRun(execution.runId);
    expect(run).toMatchObject({
      status: 'failed',
      threadId: execution.threadId,
      correlationId: execution.correlationId,
    });
    expect(h.daemon.store.getThread(execution.threadId)?.sessionId).toBe(execution.sessionId);
    const failed = h.daemon.store
      .listEvents()
      .find((event) => event.type === 'task.failed' && event.taskId === id);
    expect(failed).toMatchObject({ correlationId: execution.correlationId });
    expect(failed?.payload.execution).toEqual(execution);
    expect(failed?.payload.error).toContain('CHILD_PROVIDER_FAILURE');
  } finally {
    await h.close();
  }
});
