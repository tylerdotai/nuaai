import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('clamps an active noncooperative model slice to the persisted objective deadline', async () => {
  const h = await identityHarness(undefined, (config) => {
    config.learning.mode = 'off';
    config.limits.runTimeoutMs = 5000;
    config.limits.providerTimeoutMs = 5000;
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* () {
    await held;
    yield { type: 'done', text: 'FORBIDDEN_LATE_COMPLETION' };
  });
  try {
    const session = h.daemon.runtime.createSession(
      'Objective deadline',
      'objective-deadline',
      undefined,
      { workspaceRoot: h.project },
    );
    const accepted = await h.api('/api/runs', {
      threadId: session.thread.id,
      input: 'Describe the registered tools.',
      execution: { mode: 'continuous', durationMs: 1000, maxRuns: 3 },
    });
    await expect
      .poll(() => h.daemon.store.getRun(accepted.body.id)?.status, { timeout: 2500 })
      .toBe('failed');
    expect(h.daemon.store.getRun(accepted.body.id)?.output).toContain('Goal deadline reached');
    expect((await h.api(`/api/goals?threadId=${session.thread.id}`)).body.goals[0].status).toBe(
      'blocked',
    );
    expect(
      h.daemon.store
        .listRecentEventsForRun(accepted.body.id, 100)
        .filter((event) => event.type === 'run.completed'),
    ).toEqual([]);
  } finally {
    await h.close();
    release();
  }
}, 10_000);
