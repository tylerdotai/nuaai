import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it.each([
  { budget: 6, status: 'completed', admissions: 3 },
  { budget: 2, status: 'blocked', admissions: 2 },
])(
  'honors a 24-hour objective and finite family allowance after two virtual hours: $budget runs',
  async ({ budget, status, admissions }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const initialTime = Date.now();
    let release = () => {};
    const childReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await identityHarness(undefined, (config) => {
      config.learning.mode = 'off';
    });
    const parent = h.daemon.runtime.createSession('Long-work acceptance', 'long-work', undefined, {
      workspaceRoot: h.project,
    });
    h.daemon.runtime.setSessionApprovalPolicy(parent.session.id, 'unguarded');
    vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
      if (request.conversationId !== parent.thread.id) {
        await childReady;
        yield { type: 'done', text: 'CHILD_CONFIRMED' };
        return;
      }
      if (
        request.messages.some(
          (message) =>
            message.content.startsWith('Background task ') &&
            message.content.includes(' completed.'),
        )
      ) {
        yield { type: 'done', text: 'The child result is confirmed.' };
        return;
      }
      if (request.messages.some((message) => message.toolName === 'task.create')) {
        yield { type: 'done', text: 'The background task was started.' };
        return;
      }
      yield {
        type: 'tool_call',
        id: 'long-work-child',
        name: 'task.create',
        arguments: { agentInput: 'Return the requested child result.' },
      };
    });
    try {
      const accepted = await h.api('/api/runs', {
        threadId: parent.thread.id,
        input: 'Start a background task and return its result here.',
        execution: { mode: 'continuous', durationMs: 86_400_000, maxRuns: budget },
      });
      expect(accepted.status).toBe(200);
      await h.daemon.runtime.waitForRun(accepted.body.id);
      vi.setSystemTime(initialTime + 7_200_000);
      release();
      await expect
        .poll(
          async () =>
            (await h.api(`/api/goals?threadId=${parent.thread.id}`)).body.goals[0]?.status,
        )
        .toBe(status);
      const goal = (await h.api(`/api/goals?threadId=${parent.thread.id}`)).body.goals[0];
      expect(goal.checkpoint.policy).toMatchObject({
        mode: 'continuous',
        durationMs: 86_400_000,
        maxRuns: budget,
      });
      expect(Date.parse(goal.checkpoint.deadlineAt) - goal.createdAt).toBe(86_400_000);
      expect(goal.checkpoint.familyAdmissions).toBe(admissions);
      if (status === 'blocked') expect(goal.checkpoint.reason).toContain('budget');
      expect(
        (await h.api(`/api/threads/${parent.thread.id}/messages`)).body.messages.filter(
          (message: { role: string }) => message.role === 'user',
        ),
      ).toHaveLength(1);
    } finally {
      release();
      await h.close();
      vi.useRealTimers();
    }
  },
  15_000,
);

it('requires an explicit finite run allowance for continuous work before creating any run', async () => {
  const h = await identityHarness(undefined, (config) => {
    config.learning.mode = 'off';
  });
  try {
    const parent = h.daemon.runtime.createSession('Budget validation', 'long-budget', undefined, {
      workspaceRoot: h.project,
    });
    const result = await h.api('/api/runs', {
      threadId: parent.thread.id,
      input: 'Describe the available tools.',
      execution: { mode: 'continuous', durationMs: 86_400_000 },
    });
    expect(result.status).toBe(400);
    expect(h.daemon.store.getLatestRun(parent.thread.id)).toBeUndefined();
  } finally {
    await h.close();
  }
});
