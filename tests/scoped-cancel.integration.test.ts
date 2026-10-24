import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('persists the owning session on an aborted run terminal event for session-scoped streams', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await identityHarness(
    async () => {
      await held;
    },
    (config) => {
      config.learning.mode = 'off';
    },
  );
  try {
    const session = h.daemon.runtime.createSession(
      'Scoped cancellation',
      'scoped-cancellation',
      undefined,
      { workspaceRoot: h.project },
    );
    const run = await h.api('/api/runs', {
      threadId: session.thread.id,
      input: 'Describe the registered tools.',
    });
    await expect.poll(() => h.daemon.store.getRun(run.body.id)?.status).toBe('running');
    await h.api(`/api/threads/${session.thread.id}/runs/${run.body.id}/cancel`, {});
    expect((await h.daemon.runtime.waitForRun(run.body.id)).status).toBe('cancelled');
    expect(
      h.daemon.store
        .listRecentEventsForRun(run.body.id, 100)
        .find((event) => event.type === 'run.cancelled'),
    ).toMatchObject({ sessionId: session.session.id, threadId: session.thread.id });
  } finally {
    await h.close();
    release();
  }
});
