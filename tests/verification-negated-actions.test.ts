import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('does not demand tools for prohibited actions but still verifies positive requests after or before a prohibition', async () => {
  const h = await identityHarness();
  try {
    const task = h.daemon.scheduler.createTask(
      'Return a short acknowledgement. Do not modify files, create tasks or schedules, or take external actions.',
      'No-action smoke test',
    );
    await expect
      .poll(() => h.daemon.scheduler.listTasks().find((row) => row.id === task.id)?.status)
      .toBe('completed');
    const parent = h.daemon.runtime.createSession(
      'Verification counterexamples',
      'fixture:negation',
    );
    for (const input of [
      'Do not modify files, but inspect current workspace status.',
      'Create evidence.txt. Do not delete files.',
      'Read README.md; do not write files.',
    ]) {
      const accepted = await h.api('/api/runs', { threadId: parent.thread.id, input });
      const run = await h.daemon.runtime.waitForRun(accepted.body.id);
      expect(run.status, input).toBe('failed');
      expect(run.output).toContain('no tool was executed');
    }
  } finally {
    await h.close();
  }
});
