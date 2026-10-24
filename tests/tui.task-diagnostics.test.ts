import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { realTuiHarness } from './tui.real-harness.js';

it('shows the original task failure and linked run when opening real TUI task details', async () => {
  const h = await realTuiHarness();
  const provider = vi
    .spyOn(DeterministicProvider.prototype, 'stream')
    .mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Provisional child output' };
      throw new Error('TASK_UI_ORIGINAL_FAILURE');
    });
  try {
    const task = h.daemon.scheduler.createTask('Fixture greeting.', 'Task UI diagnostics');
    await expect
      .poll(() => h.daemon.scheduler.listTasks().find((row) => row.id === task.id)?.status)
      .toBe('failed');
    const diagnostic = await h.api(`/api/tasks/${task.id}`);
    await h.command('/tasks', task.id);
    await h.send('\r', 'TASK_UI_ORIGINAL_FAILURE');
    await h.send('\u001b[6~', diagnostic.body.execution.runId);
    expect(h.frame()).toContain(diagnostic.body.execution.runId);
    expect(h.frame()).toContain(diagnostic.body.execution.correlationId);
  } finally {
    provider.mockRestore();
    await h.close();
  }
}, 10000);
