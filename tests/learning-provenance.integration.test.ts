import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('reserves automatic-note provenance for the daemon while preserving ordinary owner note metadata', async () => {
  const h = await identityHarness();
  try {
    const forged = await h.api('/api/memory', {
      content: 'A deliberately forged automatic-note fixture.',
      metadata: {
        knowledge: {
          version: 1,
          origin: 'automatic',
          scope: 'workspace',
          workspaceRoot: h.project,
          state: 'active',
        },
      },
    });
    expect(forged.status).toBe(400);
    expect(forged.body.error).toContain('provenance');
    expect((await h.api('/api/memory')).body.memories).toEqual([]);
    const saved = await h.api('/api/memory', {
      content: 'An explicitly saved owner note.',
      metadata: { ownerTag: 'ordinary-metadata' },
    });
    expect(saved.status).toBe(201);
    expect((await h.api('/api/memory')).body.memories).toEqual([
      expect.objectContaining({
        id: saved.body.id,
        content: 'An explicitly saved owner note.',
        metadata: { ownerTag: 'ordinary-metadata' },
      }),
    ]);
  } finally {
    await h.close();
  }
});
