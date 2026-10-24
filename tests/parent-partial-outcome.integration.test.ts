import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('delivers the original child failure and actual partial artifact without claiming success or inheriting approval grants', async () => {
  const h = await identityHarness(undefined, (config) => {
    config.permissions.scheduler = 'operator';
    config.learning.mode = 'off';
  });
  const parent = h.daemon.runtime.createSession(
    'Partial child outcome',
    'partial-child',
    undefined,
    { workspaceRoot: h.project },
  );
  h.daemon.runtime.setSessionApprovalPolicy(parent.session.id, 'unguarded');
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (request.conversationId !== parent.thread.id) {
      if (request.messages.some((message) => message.toolName === 'workspace.write'))
        throw new Error('Child fixture failed after the partial report');
      yield {
        type: 'tool_call',
        id: 'partial-report-write',
        name: 'workspace.write',
        arguments: { path: 'partial-report.txt', content: 'PARTIAL_ARTIFACT_ONLY' },
      };
      return;
    }
    if (!request.messages.some((message) => message.toolName === 'task.create'))
      yield {
        type: 'tool_call',
        id: 'partial-child-create',
        name: 'task.create',
        arguments: {
          name: 'Partial report child',
          agentInput: 'Write partial-report.txt, then report the result.',
        },
      };
    else yield { type: 'done', text: 'The background task was started.' };
  });
  try {
    const accepted = await h.api('/api/runs', {
      threadId: parent.thread.id,
      input: 'Start a background task and return its result here.',
    });
    expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
    const task = h.daemon.scheduler.listTasks().find((task) => task.kind === 'background.run');
    if (!task) throw new Error('Native background task was not created');
    const execution = task.payload.execution as Record<string, string>;
    await expect
      .poll(async () =>
        (await h.api('/api/approvals?status=pending')).body.approvals.find(
          (approval: { runId: string }) => approval.runId === execution.runId,
        ),
      )
      .toBeDefined();
    const approval = (await h.api('/api/approvals?status=pending')).body.approvals.find(
      (value: { runId: string }) => value.runId === execution.runId,
    );
    expect(approval.toolName).toBe('workspace.write');
    expect(
      (
        await h.api(`/api/approvals/${approval.id}/approve`, {
          payloadHash: approval.payloadHash,
          scope: 'once',
        })
      ).status,
    ).toBe(200);
    await expect.poll(() => h.daemon.store.getTask(task.id)?.status).toBe('failed');
    const artifact = h.daemon.store
      .listRunArtifacts(execution.runId)
      .find((value) => value.mimeType === 'text/plain');
    if (!artifact?.storagePath) throw new Error('Partial artifact bytes were not captured');
    const download = await fetch(
      `http://127.0.0.1:${h.daemon.gateway.port}/api/runs/${execution.runId}/artifacts/${artifact.id}/download`,
      { headers: { authorization: `Bearer ${h.daemon.token}` } },
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('PARTIAL_ARTIFACT_ONLY');
    const notice = h.daemon.runtime
      .listMessages(parent.thread.id)
      .find((message) => message.role === 'assistant' && message.content.includes(task.id));
    if (!notice) throw new Error('No parent failure notice was delivered');
    expect(notice.content).toContain('failed');
    expect(notice?.content).toContain('Child fixture failed after the partial report');
    expect(notice?.content).toContain(artifact.id);
    expect(notice?.content).toContain('not proof of task success');
    expect(h.daemon.store.listMessageArtifacts(notice.id)).toContainEqual(
      expect.objectContaining({
        kind: 'task_result',
        payload: expect.objectContaining({ status: 'failed', childRunId: execution.runId }),
      }),
    );
  } finally {
    await h.close();
  }
}, 15_000);
