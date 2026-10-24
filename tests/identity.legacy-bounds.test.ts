import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('does not re-inject uncapped legacy context beside a truncated snapshot, and explicit refresh replaces it', async () => {
  const h = await identityHarness();
  try {
    const created = h.daemon.store.createSession(
      'Large legacy',
      Date.now(),
      `${'z'.repeat(48000)}TRAILING_PRIVATE_SENTINEL`,
    );
    const status = await h.api(`/api/sessions/${created.session.id}/identity`);
    expect(status.body.sources[0].status).toBe('truncated');
    const oldPrompt = (await h.run(created.thread.id)).systemPrompt ?? '';
    expect(oldPrompt).not.toContain('TRAILING_PRIVATE_SENTINEL');
    await writeFile(join(h.root, 'SOUL.md'), 'EXPLICIT_REFRESH_REPLACEMENT');
    await h.api(`/api/sessions/${created.session.id}/identity/refresh`, {});
    const newPrompt = (await h.run(created.thread.id)).systemPrompt ?? '';
    expect(newPrompt).toContain('EXPLICIT_REFRESH_REPLACEMENT');
    expect(newPrompt).not.toContain('zzzz');
    expect(newPrompt).not.toContain('TRAILING_PRIVATE_SENTINEL');
  } finally {
    await h.close();
  }
}, 15000);
