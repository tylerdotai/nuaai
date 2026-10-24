import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('persists automatic/manual/off learning controls, stops automatic review in manual mode and rejects agent memory saves while off', async () => {
  const h = await identityHarness();
  const before = JSON.parse(await readFile(join(h.root, '.nuaai/config.json'), 'utf8'));
  let attemptSave = false;
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (attemptSave && !request.messages.some((message) => message.role === 'tool'))
      yield {
        type: 'tool_call',
        id: 'off-save',
        name: 'memory.store',
        arguments: { content: 'Off mode must not persist this.' },
      };
    else yield { type: 'done', text: 'No new memory was saved.' };
  });
  try {
    expect(await h.api('/api/memory/learning')).toMatchObject({
      status: 200,
      body: { mode: 'automatic', enabled: true },
    });
    expect(await h.api('/api/memory/learning', { mode: 'manual' })).toMatchObject({
      status: 200,
      body: { mode: 'manual', enabled: false },
    });
    const created = h.daemon.runtime.createSession(
      'Manual learning',
      'learning-controls',
      undefined,
      { workspaceRoot: h.project },
    );
    h.daemon.runtime.setSessionApprovalPolicy(created.session.id, 'unguarded');
    const accepted = await h.api('/api/runs', {
      threadId: created.thread.id,
      input: 'I prefer concise replies for this project.',
    });
    expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
    expect(h.daemon.store.taskForSource('knowledge.review', accepted.body.id)).toBeUndefined();
    expect(h.daemon.store.searchMemoryRows()).toHaveLength(0);
    await h.restart();
    expect(await h.api('/api/memory/learning')).toMatchObject({
      status: 200,
      body: { mode: 'manual' },
    });
    expect(await h.api('/api/memory/learning', { mode: 'off' })).toMatchObject({
      status: 200,
      body: { mode: 'off' },
    });
    attemptSave = true;
    const next = await h.api('/api/runs', {
      threadId: created.thread.id,
      input: 'Remember that this is a test of disabled learning.',
    });
    expect((await h.daemon.runtime.waitForRun(next.body.id)).status).toBe('failed');
    expect(h.daemon.store.searchMemoryRows()).toHaveLength(0);
    expect(
      await h.api('/api/memory/learning', { mode: 'Automatic', permissions: { web: 'operator' } }),
    ).toMatchObject({ status: 400 });
    const after = JSON.parse(await readFile(join(h.root, '.nuaai/config.json'), 'utf8'));
    expect(after.learning.mode).toBe('off');
    expect(after.provider).toEqual(before.provider);
    expect(after.permissions).toEqual(before.permissions);
  } finally {
    await h.close();
  }
}, 15_000);
