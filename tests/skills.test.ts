import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { workspaceDirectory } from '../src/config/index.js';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { DeterministicProvider } from '../src/providers/test.js';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { SkillLearner } from '../src/skills/learner.js';
import { loadFilesystemSkills, parseSkillDocument } from '../src/skills/loader.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { initWorkspace } from '../src/workspace/fs.js';

const roots: string[] = [];
const stores: DatabaseStore[] = [];

afterEach(() => {
  roots.length = 0;
  for (const store of stores.splice(0)) store.close();
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-skills-'));
  roots.push(root);
  await initWorkspace(root);
  return root;
}

describe('skill registry', () => {
  it('registers, matches, activates, dispatches, and replaces skills', async () => {
    const registry = new SkillRegistry();
    registry.registerInstruction({
      name: 'matrix-threads',
      description: 'Handle Matrix threads.',
      version: '1.0.0',
      source: 'test',
      license: 'Proprietary',
      compatibility: 'NUAAI',
      metadata: { owner: 'test' },
      allowedTools: ['matrix.send'],
      triggers: ['Element thread', 'matrix'],
      body: 'Use the root event as the durable thread identity.',
      path: '/tmp/matrix-threads/SKILL.md',
    });
    registry.register({
      name: 'direct',
      description: 'Direct executable skill.',
      input: z.object({ value: z.string() }),
      execute: ({ value }) => value.toUpperCase(),
      triggers: ['uppercase'],
    });
    registry.registerInstruction({
      name: 'minimal',
      description: 'Minimal instruction skill.',
      source: 'test',
      metadata: {},
      triggers: [],
    });

    expect(registry.has('matrix-threads')).toBe(true);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.match('Please handle this Element thread')[0]?.name).toBe('matrix-threads');
    expect(registry.search('Please handle this Element thread')[0]?.name).toBe('matrix-threads');
    expect(registry.load('matrix-threads', new Set(['matrix.send'])).instructions).toContain(
      'durable thread identity',
    );
    expect(() => registry.load('matrix-threads', new Set())).toThrow('unavailable tools');
    expect(registry.promptContext('Handle the Matrix thread')).toContain('Activated skills');
    expect(registry.promptContext('unrelated request')).toContain('Available skills');
    expect(registry.match('Use minimal')[0]?.name).toBe('minimal');
    expect(registry.load('minimal', new Set())).toEqual({
      name: 'minimal',
      description: 'Minimal instruction skill.',
      instructions: '',
      allowedTools: [],
    });
    await expect(registry.dispatch('minimal', {})).resolves.toEqual({
      name: 'minimal',
      instructions: '',
    });
    expect(() => registry.load('missing', new Set())).toThrow('Unknown skill');
    expect(registry.promptContext('Handle the Matrix thread', 30_000, new Set())).toContain(
      'Skills not activated',
    );
    expect(
      registry.promptContext('Handle the Matrix thread', 0, new Set(['matrix.send'])),
    ).not.toContain('Activated skills');
    expect(await registry.dispatch('direct', { value: 'ok' })).toBe('OK');
    await expect(registry.dispatch('missing', {})).rejects.toThrow('Unknown skill');
    const direct = registry.get('direct');
    expect(direct).toBeDefined();
    if (!direct) throw new Error('direct skill was not registered');
    expect(() => registry.register(direct)).toThrow('already registered');
    registry.replace({
      name: 'direct',
      description: 'Replaced.',
      input: z.unknown(),
      execute: () => 'replaced',
    });
    expect(await registry.dispatch('direct', {})).toBe('replaced');
  });
});

describe('filesystem skills', () => {
  it('loads first-party skills from the installed package independently of the runtime root', async () => {
    const root = await makeRoot();
    const packageRoot = await mkdtemp(join(tmpdir(), 'nuaai-package-skills-'));
    roots.push(packageRoot);
    const skillRoot = join(packageRoot, 'skills', 'bundled-skill');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      '---\nname: bundled-skill\ndescription: Bundled release skill.\nlicense: MIT\n---\n\nUse bundled instructions.\n',
    );
    const registry = new SkillRegistry();

    const loaded = await loadFilesystemSkills(
      root,
      registry,
      undefined,
      join(packageRoot, 'skills'),
    );

    expect(loaded.map((skill) => skill.name)).toEqual(['bundled-skill']);
    expect(registry.load('bundled-skill', new Set()).instructions).toContain(
      'bundled instructions',
    );
  });

  it('parses valid metadata and rejects malformed frontmatter', () => {
    const document = `---
name: sample-skill
description: A valid sample skill.
license: Proprietary
compatibility: NUAAI
allowed-tools: matrix.send workspace.read
metadata:
  author: test
  triggers: "sample, validation"
---

# Instructions

Use the skill when requested.
`;
    const manifest = parseSkillDocument(document, 'sample-skill', '/tmp/sample/SKILL.md');
    expect(manifest).toMatchObject({
      name: 'sample-skill',
      triggers: ['sample', 'validation'],
      allowedTools: ['matrix.send', 'workspace.read'],
    });
    expect(() => parseSkillDocument('name: missing-frontmatter', 'bad')).toThrow('frontmatter');
    expect(() =>
      parseSkillDocument('---\nname: bad\ndescription: bad\nmetadata: invalid\n---\n\nbody', 'bad'),
    ).toThrow('string-to-string map');
    expect(() =>
      parseSkillDocument(
        '---\nname: bad\ndescription: bad\nmetadata:\n  version: 2\n---\n\nbody',
        'bad',
      ),
    ).toThrow('metadata value must be a string');
    expect(() => parseSkillDocument('---\nnot frontmatter\n---\n\nbody', 'bad')).toThrow(
      'Invalid SKILL.md frontmatter line',
    );
    expect(() => parseSkillDocument(document, 'wrong-name')).toThrow('parent directory');
  });

  it('loads standard skills, ignores duplicates, and records trigger metadata', async () => {
    const root = await makeRoot();
    const skillsRoot = join(root, 'skills', 'sample-skill');
    await mkdir(skillsRoot, { recursive: true });
    await writeFile(
      join(skillsRoot, 'SKILL.md'),
      `---\nname: sample-skill\ndescription: A sample skill.\nmetadata:\n  triggers: "sample, test"\n---\n\nDo the sample workflow.\n`,
    );
    const invalidRoot = join(root, 'skills', 'invalid-skill');
    await mkdir(invalidRoot, { recursive: true });
    await writeFile(join(invalidRoot, 'SKILL.md'), '---\nnot valid frontmatter\n---\n\nignored\n');
    const registry = new SkillRegistry();
    const loaded = await loadFilesystemSkills(root, registry);
    expect(loaded.map((skill) => skill.name)).toContain('sample-skill');
    expect(registry.match('run the sample workflow')[0]?.name).toBe('sample-skill');
    expect((await loadFilesystemSkills(root, registry)).map((skill) => skill.name)).not.toContain(
      'sample-skill',
    );
  });
});

describe('automatic skill learning', () => {
  it('creates validated trigger-driven SKILL.md files and avoids collisions', async () => {
    const root = await makeRoot();
    const registry = new SkillRegistry();
    const learner = new SkillLearner(root, registry);

    expect(await learner.learnFromRun('just do the thing')).toBeUndefined();
    const first = await learner.learnFromRun(
      'learn skill Matrix Replies: Reply to Matrix threads with the root event relation',
    );
    const second = await learner.learnFromRun(
      'save this as a skill called Matrix Replies\nReply to Element threads consistently',
    );
    const unnamed = await learner.learnFromRun('save this as a skill\nx');

    expect(first?.name).toBe('matrix-replies');
    expect(second?.name).toBe('matrix-replies-2');
    expect(unnamed?.name).toBe('x');
    expect(first?.triggers).toContain('matrix');
    expect(registry.match('reply to Matrix threads')[0]?.name).toBe('matrix-replies');
    if (!first) throw new Error('first learned skill was not created');
    const firstDocument = await readFile(first.path, 'utf8');
    expect(firstDocument).toContain('name: matrix-replies');
    expect(firstDocument).toContain('triggers:');
    expect(workspaceDirectory(root)).toContain('.nuaai');
  });
});

describe('skill-aware runtime execution', () => {
  it('requires write permission for persistent learning and still learns for operators', async () => {
    const root = await makeRoot();
    const store = new DatabaseStore(openAppDatabase(root));
    stores.push(store);
    const provider = new DeterministicProvider();
    const providers = {
      get: (name: string) => {
        if (name !== 'ollama' && name !== 'deterministic')
          throw new Error(`Unknown provider: ${name}`);
        return provider;
      },
      active: () => ({ name: 'ollama', model: provider.model }),
    } as never;
    const skills = new SkillRegistry();
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers,
      tools: new ToolRegistry(root),
      skills,
      skillLearner: new SkillLearner(root, skills),
    });
    const created = runtime.createSession('Skill runtime');
    store.updateSessionContext(created.session.id, 'Remember the test context.');
    const readOnlyRun = runtime.startRun({
      threadId: created.thread.id,
      input: 'learn skill Read Only Learning: This must not persist',
      permissions: permissionContextForProfile('read-only'),
    });

    await expect(runtime.waitForRun(readOnlyRun.id)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(skills.has('read-only-learning')).toBe(false);
    expect(store.listEvents().map((event) => event.type)).not.toContain('skill.learned');

    const operatorRun = runtime.startRun({
      threadId: created.thread.id,
      input: 'learn skill Runtime Learning: Persist this workflow for future runs',
      permissions: permissionContextForProfile('operator'),
    });
    await expect(runtime.waitForRun(operatorRun.id)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(skills.has('runtime-learning')).toBe(true);
    expect(store.listEvents().map((event) => event.type)).toContain('skill.learned');
  });
});
