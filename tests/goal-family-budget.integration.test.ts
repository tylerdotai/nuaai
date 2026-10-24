import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('caps the whole owned goal family rather than allowing recursively delegated goals to evade per-goal budgets', async () => {
  const h = await identityHarness(undefined, (config) => {
    config.learning.mode = 'off';
    config.limits.maxGoalFamilyRuns = 3;
  });
  const parent = h.daemon.runtime.createSession(
    'Bounded goal family',
    'bounded-goal-family',
    undefined,
    { workspaceRoot: h.project },
  );
  h.daemon.runtime.setSessionApprovalPolicy(parent.session.id, 'unguarded');
  const stopPolicyFixture = h.daemon.runtime.subscribe((event) => {
    if (event.type === 'session.created' && event.sessionId)
      h.daemon.runtime.setSessionApprovalPolicy(event.sessionId, 'unguarded');
  });
  const threads = new Set<string>();
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    threads.add(request.conversationId ?? 'unknown');
    if (
      request.messages.some(
        (message) =>
          message.content.startsWith('Background task ') && message.content.includes(' completed.'),
      )
    ) {
      yield { type: 'done', text: 'The owned result was returned.' };
      return;
    }
    if (request.messages.some((message) => message.toolName === 'task.create')) {
      yield { type: 'done', text: 'The background task was started.' };
      return;
    }
    // Bound the hostile provider fixture itself even when the product lacks the family limit.
    if (threads.size >= 5) {
      yield { type: 'done', text: 'FIXTURE_DEPTH_STOP' };
      return;
    }
    yield {
      type: 'tool_call',
      id: `recursive-child-${threads.size}`,
      name: 'task.create',
      arguments: { agentInput: 'Start a background task and return its result here.' },
    };
  });
  try {
    const accepted = await h.api('/api/runs', {
      threadId: parent.thread.id,
      input: 'Start a background task and return its result here.',
    });
    await h.daemon.runtime.waitForRun(accepted.body.id);
    await expect
      .poll(async () =>
        (await h.api('/api/goals')).body.goals.every((goal: { status: string }) =>
          ['completed', 'blocked', 'cancelled', 'superseded'].includes(goal.status),
        ),
      )
      .toBe(true);
    expect(threads.size).toBeLessThanOrEqual(3);
    expect((await h.api(`/api/goals?threadId=${parent.thread.id}`)).body.goals[0]).toMatchObject({
      status: 'blocked',
    });
    expect(
      h.daemon.scheduler
        .listTasks()
        .filter((task) => task.kind === 'background.run')
        .some((task) => task.status === 'failed'),
    ).toBe(true);
    expect(h.daemon.store.listActiveRuns()).toEqual([]);
  } finally {
    stopPolicyFixture();
    await h.close();
  }
}, 15_000);
