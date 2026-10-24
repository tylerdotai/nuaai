import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('lets a schema-driven provider rename a schedule through the advertised native update contract', async () => {
  const h = await identityHarness();
  const schedule = h.daemon.scheduler.create({
    name: 'Original fixture',
    type: 'manual',
    expression: '',
    agentInput: 'Reply READY without using tools.',
    enabled: false,
  });
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (request.messages.some((message) => message.role === 'tool')) {
      yield { type: 'done', text: 'Schedule update returned.' };
      return;
    }
    const schema = request.tools?.find((tool) => tool.name === 'schedule.update');
    const fields = schema?.parameters.properties as Record<string, unknown> | undefined;
    yield {
      type: 'tool_call',
      id: 'rename-schedule',
      name: 'schedule.update',
      arguments: { id: schedule.id, ...(fields?.name ? { name: 'Updated fixture' } : {}) },
    };
  });
  try {
    const session = h.daemon.runtime.createSession(
      'Schedule schema',
      'test:schedule-schema',
      undefined,
      { workspaceRoot: h.project },
    );
    await h.api(`/api/sessions/${session.session.id}/permissions`, {
      mode: 'unguarded',
      confirmUnguarded: true,
    });
    const accepted = await h.api('/api/runs', {
      threadId: session.thread.id,
      input: 'Update the native schedule name to Updated fixture.',
    });
    expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
    expect(h.daemon.scheduler.list().find((item) => item.id === schedule.id)?.name).toBe(
      'Updated fixture',
    );
  } finally {
    await h.close();
  }
});
