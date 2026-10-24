import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { loadFilesystemSkills } from '../src/skills/loader.js';
import { SkillRegistry } from '../src/skills/registry.js';

const roots: string[] = [];
const stores: DatabaseStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('persists disabled skills through loader-created registries and rejects every instruction entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backend-skills-'));
  roots.push(root);
  await mkdir(join(root, 'skills', 'fixture-skill'), { recursive: true });
  await writeFile(
    join(root, 'skills', 'fixture-skill', 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: Fixture description\nmetadata:\n  triggers: fixture\n---\nPRIVATE_INSTRUCTION_BODY',
  );
  let store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  const first = new SkillRegistry();
  await loadFilesystemSkills(root, first, store);
  first.disable('fixture-skill');
  expect(first.list()).toContainEqual(
    expect.objectContaining({ name: 'fixture-skill', enabled: false }),
  );
  expect(first.promptContext('fixture')).not.toContain('Fixture description');
  expect(first.match('fixture')).toEqual([]);
  expect(() => first.load('fixture-skill')).toThrow(/disabled/);
  await expect(first.dispatch('fixture-skill', {})).rejects.toThrow(/disabled/);
  store.close();
  stores.pop();
  store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  const restarted = new SkillRegistry();
  await loadFilesystemSkills(root, restarted, store);
  expect(restarted.list()).toContainEqual(
    expect.objectContaining({ name: 'fixture-skill', enabled: false }),
  );
  expect(restarted.search('fixture')).toEqual([]);
  restarted.enable('fixture-skill');
  expect(restarted.load('fixture-skill').instructions).toBe('PRIVATE_INSTRUCTION_BODY');
  const reloaded = new SkillRegistry();
  await loadFilesystemSkills(root, reloaded, store);
  expect(reloaded.list()).toContainEqual(
    expect.objectContaining({ name: 'fixture-skill', enabled: true }),
  );
});
