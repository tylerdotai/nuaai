import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('lets the agent inspect a failed task by id and retains the same diagnostics after daemon restart', async () => {
  const h = await identityHarness(async () => {
    throw new Error('ACTUAL_CHILD_DIAGNOSTIC');
  });
  let provider: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const task = h.daemon.scheduler.createTask('Fixture greeting.', 'Inspectable task');
    await expect
      .poll(() => h.daemon.scheduler.listTasks().find((row) => row.id === task.id)?.status)
      .toBe('failed');
    provider = vi
      .spyOn(DeterministicProvider.prototype, 'stream')
      .mockImplementation(async function* (request) {
        const observation = request.messages.find((message) => message.toolName === 'task.inspect');
        if (!observation)
          yield {
            type: 'tool_call' as const,
            id: 'diagnose',
            name: 'task.inspect',
            arguments: { id: task.id },
          };
        else {
          const diagnostic = JSON.parse(observation.content);
          if (!diagnostic.execution || !diagnostic.failure) {
            yield {
              type: 'done' as const,
              text: `Task inspection did not provide diagnostics: ${observation.content}`,
            };
            return;
          }
          yield {
            type: 'done' as const,
            text: `The background run ${diagnostic.execution.runId} failed: ${diagnostic.failure.message}`,
          };
        }
      });
    const parent = h.daemon.runtime.createSession('Diagnostic caller', 'fixture:diagnostic');
    const accepted = await h.api('/api/runs', {
      threadId: parent.thread.id,
      input: `Use task.inspect to diagnose task ${task.id}.`,
    });
    const result = await h.daemon.runtime.waitForRun(accepted.body.id);
    expect(result.status, result.output).toBe('completed');
    expect(result.output).toContain('ACTUAL_CHILD_DIAGNOSTIC');
    const before = await h.api(`/api/tasks/${task.id}`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      found: true,
      linkage: 'recorded',
      failure: { message: expect.stringContaining('ACTUAL_CHILD_DIAGNOSTIC') },
    });
    expect(JSON.stringify(before.body)).not.toContain('Fixture greeting.');
    await h.restart();
    const after = await h.api(`/api/tasks/${task.id}`);
    expect(after.body.execution).toEqual(before.body.execution);
    expect(after.body.failure).toEqual(before.body.failure);
  } finally {
    provider?.mockRestore();
    await h.close();
  }
});
