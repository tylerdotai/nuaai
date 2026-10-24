import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('cancels the waiting goal and owned child before late output can resume the parent', async () => {
  const h = await identityHarness(undefined, (config) => {
    config.learning.mode = 'off';
  });
  const parent = h.daemon.runtime.createSession(
    'Cancel waiting goal',
    'cancel-waiting-goal',
    undefined,
    { workspaceRoot: h.project },
  );
  h.daemon.runtime.setSessionApprovalPolicy(parent.session.id, 'unguarded');
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (request.conversationId !== parent.thread.id) {
      await gate;
      yield { type: 'done', text: 'LATE_CHILD_RESULT' };
      return;
    }
    if (
      request.messages.some(
        (message) =>
          message.content.startsWith('Background task ') && message.content.includes(' completed.'),
      )
    ) {
      yield { type: 'done', text: 'FORBIDDEN_AUTOMATIC_PARENT_RESUME' };
      return;
    }
    if (request.messages.some((message) => message.toolName === 'task.create')) {
      yield { type: 'done', text: 'The background task was started.' };
      return;
    }
    yield {
      type: 'tool_call',
      id: 'waiting-child',
      name: 'task.create',
      arguments: { agentInput: 'Answer with the child result.' },
    };
  });
  try {
    const accepted = await h.api('/api/runs', {
      threadId: parent.thread.id,
      input: 'Start a background task and return its result here.',
    });
    expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
    expect((await h.api(`/api/goals?threadId=${parent.thread.id}`)).body.goals[0].status).toBe(
      'waiting',
    );
    expect((await h.api(`/api/runs/${accepted.body.id}/cancel`, {})).status).toBe(200);
    release();
    await expect
      .poll(
        () => h.daemon.scheduler.listTasks().find((task) => task.kind === 'background.run')?.status,
      )
      .toBe('cancelled');
    expect((await h.api(`/api/goals?threadId=${parent.thread.id}`)).body.goals[0]).toMatchObject({
      status: 'cancelled',
      sliceCount: 1,
    });
    expect(
      h.daemon.runtime
        .listMessages(parent.thread.id)
        .some((message) => message.content.includes('FORBIDDEN_AUTOMATIC_PARENT_RESUME')),
    ).toBe(false);
  } finally {
    release();
    await h.close();
  }
}, 15_000);
