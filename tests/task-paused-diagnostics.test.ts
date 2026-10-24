import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('reports the exact pending approval behind a paused background task and clears the pause after approval', async () => {
  const h = await identityHarness();
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (!request.messages.some((message) => message.role === 'tool'))
      yield {
        type: 'tool_call',
        id: 'read-command',
        name: 'workspace.command',
        arguments: { command: 'pwd' },
      };
    else yield { type: 'done', text: 'Workspace command completed.' };
  });
  try {
    const task = h.daemon.scheduler.createTask('Run the pwd command.', 'Approval diagnostic');
    await expect.poll(() => h.daemon.scheduler.inspectTask(task.id)?.run?.status).toBe('paused');
    const diagnostic = (await h.api(`/api/tasks/${task.id}`)).body;
    expect(diagnostic.pause).toMatchObject({
      reason: 'approval_required',
      approval: { toolName: 'workspace.command', status: 'pending' },
    });
    expect(diagnostic.pause.approval.id).toBe(h.daemon.runtime.listApprovals('pending')[0].id);
    expect(diagnostic.pause.approval.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      diagnostic.events.find((event: { type: string }) => event.type === 'run.paused'),
    ).toMatchObject({ reason: 'approval_required', approvalId: diagnostic.pause.approval.id });
    expect(JSON.stringify(diagnostic)).not.toContain('Run the pwd command.');
    await h.api(`/api/approvals/${diagnostic.pause.approval.id}/approve`, {
      payloadHash: diagnostic.pause.approval.payloadHash,
    });
    await expect.poll(() => h.daemon.scheduler.inspectTask(task.id)?.task.status).toBe('completed');
    expect((await h.api(`/api/tasks/${task.id}`)).body.pause).toBeUndefined();
  } finally {
    for (const approval of h.daemon.runtime.listApprovals('pending'))
      h.daemon.runtime.denyApproval(approval.id, approval.payloadHash);
    await expect
      .poll(() => h.daemon.scheduler.listTasks().every((task) => task.status !== 'running'))
      .toBe(true);
    await h.close();
  }
});
