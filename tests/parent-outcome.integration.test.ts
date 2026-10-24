import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('inherits native parent identity and returns the actual background outcome once across restart', async () => {
  const h = await identityHarness();
  const parent = h.daemon.runtime.createSession(
    'Parent outcome acceptance',
    'parent-outcome',
    undefined,
    { workspaceRoot: h.project },
  );
  h.daemon.runtime.setSessionApprovalPolicy(parent.session.id, 'unguarded');
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (request.conversationId?.startsWith('knowledge:')) {
      yield { type: 'done', text: '{"candidates":[]}' };
      return;
    }
    if (request.conversationId !== parent.thread.id) {
      yield { type: 'done', text: 'CHILD_RESULT: amber.' };
      return;
    }
    if (!request.messages.some((message) => message.toolName === 'task.create'))
      yield {
        type: 'tool_call',
        id: 'native-background-child',
        name: 'task.create',
        arguments: { name: 'Scoped child', agentInput: 'Answer with CHILD_RESULT: amber.' },
      };
    else yield { type: 'done', text: 'The background task was started.' };
  });
  try {
    const accepted = await h.api('/api/runs', {
      threadId: parent.thread.id,
      input: 'Start a background task and return its result here.',
    });
    expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
    await expect
      .poll(
        () => h.daemon.scheduler.listTasks().find((task) => task.kind === 'background.run')?.status,
      )
      .toBe('completed');
    const task = h.daemon.scheduler.listTasks().find((task) => task.kind === 'background.run');
    const execution = task?.payload.execution as Record<string, string>;
    expect(h.daemon.store.getSessionIdentity(execution.sessionId)).toMatchObject({
      workspaceRoot: h.project,
      inheritedFrom: { sessionId: parent.session.id },
    });
    await expect
      .poll(() =>
        h.daemon.runtime
          .listMessages(parent.thread.id)
          .filter(
            (message) =>
              message.role === 'assistant' && message.content.includes('CHILD_RESULT: amber.'),
          ),
      )
      .toEqual([expect.objectContaining({ content: expect.stringContaining('completed') })]);
    const notices = h.daemon.runtime
      .listMessages(parent.thread.id)
      .filter((message) => message.content.includes('CHILD_RESULT: amber.'));
    await h.restart();
    expect(
      h.daemon.runtime
        .listMessages(parent.thread.id)
        .filter((message) => message.content.includes('CHILD_RESULT: amber.')),
    ).toEqual(notices);
  } finally {
    await h.close();
  }
}, 15_000);
