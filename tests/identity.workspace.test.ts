import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('uses the bound project for the model manifest and real tool reads rather than the daemon directory', async () => {
  const h = await identityHarness();
  const fixture = vi
    .spyOn(DeterministicProvider.prototype, 'stream')
    .mockImplementation(async function* (request) {
      h.observed.push(request);
      if (!request.messages.some((message) => message.role === 'tool'))
        yield {
          type: 'tool_call' as const,
          id: 'project-read',
          name: 'workspace.read',
          arguments: { path: 'marker.txt' },
        };
      else yield { type: 'done' as const, text: 'Project file read verified.' };
    });
  try {
    await writeFile(join(h.root, 'marker.txt'), 'WRONG_DAEMON_WORKSPACE');
    await writeFile(join(h.project, 'marker.txt'), 'RIGHT_SESSION_WORKSPACE');
    const session = await h.api('/api/sessions', { workspaceRoot: h.project });
    const run = await h.api('/api/runs', {
      threadId: session.body.thread.id,
      input: 'Read marker.txt.',
    });
    expect((await h.daemon.runtime.waitForRun(run.body.id)).status).toBe('completed');
    expect(
      h.observed.at(-1)?.messages.find((message) => message.role === 'tool')?.content,
    ).toContain('RIGHT_SESSION_WORKSPACE');
    expect(h.observed[0].systemPrompt).toContain(`Workspace: ${h.project}`);
  } finally {
    fixture.mockRestore();
    await h.close();
  }
}, 15000);

it('fails explicitly on corrupt stored identity instead of disclosing it or rereading files to hide the problem', async () => {
  const h = await identityHarness();
  try {
    const session = await h.api('/api/sessions', {});
    const snapshot = h.daemon.store.getSessionIdentity(session.body.session.id);
    if (!snapshot) throw new Error('Missing snapshot');
    h.daemon.store.database.raw
      .prepare('UPDATE session_identity_snapshots SET snapshot=? WHERE id=?')
      .run(JSON.stringify({ ...snapshot, version: 'PRIVATE_CORRUPT_SENTINEL' }), snapshot.id);
    const status = await h.api(`/api/sessions/${session.body.session.id}/identity`);
    expect(status.status).toBe(400);
    expect(JSON.stringify(status.body)).not.toContain('PRIVATE_CORRUPT_SENTINEL');
    const run = await h.api('/api/runs', {
      threadId: session.body.thread.id,
      input: 'Fixture; do not use tools.',
    });
    expect(run.status).toBe(400);
    expect(h.observed).toEqual([]);
  } finally {
    await h.close();
  }
}, 15000);
