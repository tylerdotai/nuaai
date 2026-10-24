import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { realTuiHarness } from './tui.real-harness.js';

it('takes a paused task to its child approval card without silently approving it', async () => {
  const h = await realTuiHarness();
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (!request.messages.some((m) => m.role === 'tool'))
      yield {
        type: 'tool_call',
        id: 'background-command',
        name: 'workspace.command',
        arguments: { command: 'pwd' },
      };
    else yield { type: 'done', text: 'Workspace command completed.' };
  });
  try {
    const task = h.daemon.scheduler.createTask('Run the pwd command.', 'Paused child approval');
    await expect.poll(() => h.daemon.scheduler.inspectTask(task.id)?.run?.status).toBe('paused');
    await h.command('/tasks', task.id);
    await h.send('\r', 'approval_required');
    await h.send('Review child', 'Review child conversation');
    await h.send('\r', 'Approval required');
    expect(h.daemon.runtime.listApprovals('pending')).toHaveLength(1);
    await h.send('\u0019', 'Workspace command completed.');
    await expect.poll(() => h.daemon.scheduler.inspectTask(task.id)?.task.status).toBe('completed');
  } finally {
    for (const approval of h.daemon.runtime.listApprovals('pending'))
      h.daemon.runtime.denyApproval(approval.id, approval.payloadHash);
    await expect
      .poll(() => h.daemon.scheduler.listTasks().every((task) => task.status !== 'running'))
      .toBe(true);
    await h.close();
  }
}, 15000);
