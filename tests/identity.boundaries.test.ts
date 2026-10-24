import { link, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('reports bounded source outcomes without leaking content or following source links, parent directories or references', async () => {
  const h = await identityHarness();
  try {
    const outside = await mkdtemp(join(tmpdir(), 'identity-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'OUTSIDE_PRIVATE_CONTENT');
    await symlink(join(outside, 'secret.txt'), join(h.root, 'SOUL.md'));
    await mkdir(join(h.root, 'AGENTS.md'));
    await writeFile(join(h.project, 'SOUL.md'), ' \n\t');
    await writeFile(join(h.project, 'AGENTS.md'), `${'z'.repeat(11999)}界`);
    const created = await h.api('/api/sessions', { workspaceRoot: h.project });
    expect(created.status).toBe(200);
    const status = await h.api(`/api/sessions/${created.body.session.id}/identity`);
    expect(status.body.sources.map((source: { status: string }) => source.status)).toEqual([
      'unreadable',
      'unreadable',
      'empty',
      'truncated',
    ]);
    expect(status.body.sources[3].bytesRead).toBe(12000);
    expect(JSON.stringify(status.body)).not.toContain('zzzz');
    const prompt = (await h.run(created.body.thread.id)).systemPrompt ?? '';
    expect(prompt).not.toContain('OUTSIDE_PRIVATE_CONTENT');
    expect(prompt).not.toContain('�');
    expect(prompt).toContain('[truncated by NUAAI]');
    const linked = join(h.project, 'linked');
    await mkdir(linked);
    await link(join(outside, 'secret.txt'), join(linked, 'SOUL.md'));
    const linkedSession = await h.api('/api/sessions', { workspaceRoot: linked });
    expect(
      (await h.api(`/api/sessions/${linkedSession.body.session.id}/identity`)).body.sources.at(-2)
        .status,
    ).toBe('unreadable');
    await symlink(outside, join(h.root, 'escape'));
    expect((await h.api('/api/sessions', { workspaceRoot: join(h.root, 'escape') })).status).toBe(
      400,
    );
    expect((await h.api('/api/sessions', { workspaceRoot: outside })).status).toBe(400);
    const nested = join(h.project, 'nested');
    await mkdir(nested);
    await writeFile(
      join(h.project, 'AGENTS.md'),
      'PARENT_MUST_NOT_BE_DISCOVERED. Read ../private/AGENTS.md too.',
    );
    await mkdir(join(h.root, 'private'));
    await writeFile(join(h.root, 'private/AGENTS.md'), 'REFERENCED_PRIVATE_INSTRUCTION');
    const nestedSession = await h.api('/api/sessions', { workspaceRoot: nested });
    const nestedPrompt = (await h.run(nestedSession.body.thread.id)).systemPrompt ?? '';
    expect(nestedPrompt).not.toContain('PARENT_MUST_NOT_BE_DISCOVERED');
    expect(nestedPrompt).not.toContain('REFERENCED_PRIVATE_INSTRUCTION');
    expect(
      (await h.api(`/api/sessions/${nestedSession.body.session.id}/identity`)).body.sources
        .slice(-2)
        .map((source: { status: string }) => source.status),
    ).toEqual(['missing', 'missing']);
  } finally {
    await h.close();
  }
}, 15000);
