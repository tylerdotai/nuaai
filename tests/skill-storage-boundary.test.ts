import { access, mkdir, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';
it('rejects malformed skill names before creating files and refuses symlinked private skill storage', async () => {
  const h = await identityHarness();
  try {
    const rejected = await h.api('/api/skills', {
      name: 'bad--name',
      instructions: 'Must not be written.',
    });
    expect(rejected.status).toBe(400);
    await expect(access(join(h.root, '.nuaai/skills/bad--name'))).rejects.toThrow();
    const outside = join(h.root, 'outside-skill-storage');
    await mkdir(outside);
    // A different runtime root keeps the first assertion's storage separate.
    const { SkillLearner } = await import('../src/skills/learner.js');
    const { SkillRegistry } = await import('../src/skills/registry.js');
    const root = join(h.root, 'other');
    await mkdir(join(root, '.nuaai'), { recursive: true });
    await symlink(outside, join(root, '.nuaai/skills'));
    await expect(
      new SkillLearner(root, new SkillRegistry()).create('valid-name', 'Do not escape.'),
    ).rejects.toThrow('private real directory');
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await h.close();
  }
}, 15000);
