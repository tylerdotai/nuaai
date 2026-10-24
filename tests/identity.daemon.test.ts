import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('captures both instruction files per real daemon session, keeps snapshots private and stable, and refreshes explicitly across restart', async () => {
  const h = await identityHarness();
  try {
    await writeFile(join(h.root, 'SOUL.md'), 'GLOBAL_SOUL_1');
    await writeFile(join(h.root, 'AGENTS.md'), 'GLOBAL_AGENTS_1');
    await writeFile(join(h.project, 'SOUL.md'), 'PROJECT_SOUL_1');
    await writeFile(join(h.project, 'AGENTS.md'), 'PROJECT_AGENTS_1');
    const first = await h.api('/api/sessions', {
      title: 'Project identity',
      workspaceRoot: h.project,
    });
    expect(first.status).toBe(200);
    const prompt = (await h.run(first.body.thread.id)).systemPrompt ?? '';
    expect(prompt).toContain('GLOBAL_SOUL_1');
    expect(prompt).toContain('GLOBAL_AGENTS_1');
    expect(prompt).toContain('PROJECT_SOUL_1');
    expect(prompt).toContain('PROJECT_AGENTS_1');
    expect(prompt.indexOf('GLOBAL_SOUL_1')).toBeLessThan(prompt.indexOf('GLOBAL_AGENTS_1'));
    expect(prompt.indexOf('GLOBAL_AGENTS_1')).toBeLessThan(prompt.indexOf('PROJECT_SOUL_1'));
    expect(prompt.indexOf('PROJECT_SOUL_1')).toBeLessThan(prompt.indexOf('PROJECT_AGENTS_1'));
    expect(JSON.stringify(first.body)).not.toContain('PROJECT_AGENTS_1');
    const status = await h.api(`/api/sessions/${first.body.session.id}/identity`);
    expect(status.status).toBe(200);
    expect(status.body.workspaceRoot).toBe(h.project);
    expect(status.body.revision).toBe(1);
    expect(status.body.sources.map((source: { status: string }) => source.status)).toEqual([
      'loaded',
      'loaded',
      'loaded',
      'loaded',
    ]);
    expect(JSON.stringify(status.body)).not.toContain('GLOBAL_SOUL_1');
    expect(JSON.stringify((await h.api('/api/sessions')).body)).not.toContain('GLOBAL_SOUL_1');
    await writeFile(join(h.project, 'AGENTS.md'), 'PROJECT_AGENTS_2');
    expect((await h.run(first.body.thread.id)).systemPrompt).toContain('PROJECT_AGENTS_1');
    const second = await h.api('/api/sessions', {
      title: 'New identity',
      workspaceRoot: h.project,
    });
    expect((await h.run(second.body.thread.id)).systemPrompt).toContain('PROJECT_AGENTS_2');
    const refreshed = await h.api(`/api/sessions/${first.body.session.id}/identity/refresh`, {});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.revision).toBe(2);
    expect((await h.run(first.body.thread.id)).systemPrompt).toContain('PROJECT_AGENTS_2');
    await writeFile(join(h.project, 'AGENTS.md'), 'PROJECT_AGENTS_3');
    await h.restart();
    const recovered = (await h.run(first.body.thread.id)).systemPrompt ?? '';
    expect(recovered).toContain('PROJECT_AGENTS_2');
    expect(recovered).not.toContain('PROJECT_AGENTS_3');
    expect((await h.api(`/api/sessions/${first.body.session.id}/identity`)).body.revision).toBe(2);
  } finally {
    await h.close();
  }
}, 15000);
