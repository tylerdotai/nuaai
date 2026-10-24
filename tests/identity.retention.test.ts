import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('pins each queued run to the admitted revision even when the session refreshes during an active turn', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const h = await identityHarness(async () => {
    if (++calls === 1) await held;
  });
  try {
    await writeFile(join(h.root, 'SOUL.md'), 'PINNED_IDENTITY_1');
    const created = await h.api('/api/sessions', {});
    const threadId = created.body.thread.id;
    const first = await h.api('/api/runs', { threadId, input: 'First fixture; do not use tools.' });
    await expect.poll(() => h.observed.length).toBe(1);
    const queued = await h.api('/api/runs', {
      threadId,
      input: 'Second fixture; do not use tools.',
    });
    await writeFile(join(h.root, 'SOUL.md'), 'PINNED_IDENTITY_2');
    await h.api(`/api/sessions/${created.body.session.id}/identity/refresh`, {});
    const after = await h.api('/api/runs', { threadId, input: 'Third fixture; do not use tools.' });
    release();
    for (const run of [first, queued, after])
      expect((await h.daemon.runtime.waitForRun(run.body.id)).status).toBe('completed');
    expect(h.observed[0].systemPrompt).toContain('PINNED_IDENTITY_1');
    expect(h.observed[1].systemPrompt).toContain('PINNED_IDENTITY_1');
    expect(h.observed[2].systemPrompt).toContain('PINNED_IDENTITY_2');
  } finally {
    release();
    await h.close();
  }
}, 15000);

it('retains unknown legacy context once and makes child identity inheritance explicit, durable and independently refreshable', async () => {
  const h = await identityHarness();
  try {
    await writeFile(join(h.root, 'SOUL.md'), 'CURRENT_GLOBAL');
    const legacy = h.daemon.store.createSession('Legacy', Date.now(), 'OPAQUE_LEGACY_IDENTITY');
    const legacyStatus = await h.api(`/api/sessions/${legacy.session.id}/identity`);
    expect(legacyStatus.body.origin).toBe('legacy-retained');
    expect((await h.run(legacy.thread.id)).systemPrompt).toContain('OPAQUE_LEGACY_IDENTITY');
    expect((await h.run(legacy.thread.id)).systemPrompt).not.toContain('CURRENT_GLOBAL');
    await h.restart();
    expect((await h.run(legacy.thread.id)).systemPrompt).toContain('OPAQUE_LEGACY_IDENTITY');
    await h.api(`/api/sessions/${legacy.session.id}/identity/refresh`, {});
    expect((await h.run(legacy.thread.id)).systemPrompt).not.toContain('OPAQUE_LEGACY_IDENTITY');
    const empty = h.daemon.store.createSession('Legacy empty');
    expect((await h.api(`/api/sessions/${empty.session.id}/identity`)).body.origin).toBe(
      'legacy-captured',
    );
    const parent = await h.api('/api/sessions', { workspaceRoot: h.project });
    const child = await h.api('/api/sessions', { parentSessionId: parent.body.session.id });
    expect(child.status).toBe(200);
    const inherited = await h.api(`/api/sessions/${child.body.session.id}/identity`);
    expect(inherited.body.origin).toBe('inherited');
    expect(inherited.body.workspaceRoot).toBe(h.project);
    expect(inherited.body.inheritedFrom.sessionId).toBe(parent.body.session.id);
    await writeFile(join(h.root, 'SOUL.md'), 'UPDATED_GLOBAL');
    await h.api(`/api/sessions/${parent.body.session.id}/identity/refresh`, {});
    expect((await h.run(child.body.thread.id)).systemPrompt).toContain('CURRENT_GLOBAL');
    await h.api(`/api/sessions/${child.body.session.id}/identity/refresh`, {});
    expect((await h.run(child.body.thread.id)).systemPrompt).toContain('UPDATED_GLOBAL');
    expect(
      (
        await h.api('/api/sessions', {
          parentSessionId: parent.body.session.id,
          workspaceRoot: h.root,
        })
      ).status,
    ).toBe(400);
  } finally {
    await h.close();
  }
}, 15000);
