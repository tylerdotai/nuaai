import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('continues an owned goal after the actual child outcome without inventing another user turn', async () => {
  const h = await identityHarness(undefined, (config) => {
    config.learning.mode = 'off';
  });
  const parent = h.daemon.runtime.createSession(
    'Automatic goal continuation',
    'goal-continuation',
    undefined,
    { workspaceRoot: h.project },
  );
  h.daemon.runtime.setSessionApprovalPolicy(parent.session.id, 'unguarded');
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (request.conversationId !== parent.thread.id) {
      yield { type: 'done', text: 'CHILD_RESULT: amber.' };
      return;
    }
    if (
      request.messages.some(
        (message) =>
          message.content.startsWith('Background task ') && message.content.includes(' completed.'),
      )
    ) {
      yield { type: 'done', text: 'The completed child answered amber.' };
      return;
    }
    if (request.messages.some((message) => message.toolName === 'task.create')) {
      yield { type: 'done', text: 'The background task was started.' };
      return;
    }
    yield {
      type: 'tool_call',
      id: 'goal-child-create',
      name: 'task.create',
      arguments: { agentInput: 'Answer with CHILD_RESULT: amber.' },
    };
  });
  try {
    const input = 'Start a background task and return its result here.';
    const accepted = await h.api('/api/runs', { threadId: parent.thread.id, input });
    expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
    const listed = await h.api(`/api/goals?threadId=${parent.thread.id}`);
    expect(listed.status).toBe(200);
    await expect
      .poll(
        async () =>
          (await h.api(`/api/goals?threadId=${parent.thread.id}`)).body.goals.find(
            (goal: { rootRunId: string }) => goal.rootRunId === accepted.body.id,
          )?.status,
      )
      .toBe('completed');
    const goal = (await h.api(`/api/goals?threadId=${parent.thread.id}`)).body.goals.find(
      (value: { rootRunId: string }) => value.rootRunId === accepted.body.id,
    );
    expect(goal).toMatchObject({ status: 'completed', sliceCount: 2 });
    expect(
      h.daemon.runtime
        .listMessages(parent.thread.id)
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual([input]);
    expect(h.daemon.runtime.listMessages(parent.thread.id).at(-1)?.content).toBe(
      'The completed child answered amber.',
    );
    await h.restart();
    expect(
      (await h.api(`/api/goals?threadId=${parent.thread.id}`)).body.goals.find(
        (value: { id: string }) => value.id === goal.id,
      ),
    ).toMatchObject({ status: 'completed', sliceCount: 2 });
  } finally {
    await h.close();
  }
}, 15_000);
