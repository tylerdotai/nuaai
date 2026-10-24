import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { SkillLearner } from '../src/skills/learner.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';

it('lets the agent create, discover, search and retrieve a real durable skill with normal permission enforcement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-skill-tools-'));
  const skills = new SkillRegistry();
  const learner = new SkillLearner(root, skills);
  const tools = new ToolRegistry(root, undefined, {}, { skills, skillLearner: learner });
  const context = { root, permissions: permissionContextForProfile('operator') };
  const created = (await tools.execute(
    'skill.create',
    {
      name: 'invoice-check',
      instructions: 'Verify INVOICE_ACCEPTANCE_SENTINEL before approving an invoice.',
    },
    context,
  )) as { name: string; path: string };
  expect(await readFile(created.path, 'utf8')).toContain('INVOICE_ACCEPTANCE_SENTINEL');
  expect(JSON.stringify(await tools.execute('skill.list', {}, context))).toContain('invoice-check');
  expect(
    JSON.stringify(await tools.execute('skill.search', { query: 'invoice' }, context)),
  ).toContain('invoice-check');
  expect(
    JSON.stringify(await tools.execute('skill.load', { name: 'invoice-check' }, context)),
  ).toContain('INVOICE_ACCEPTANCE_SENTINEL');
  await expect(
    tools.execute(
      'skill.create',
      { name: 'forbidden', instructions: 'No write' },
      { root, permissions: permissionContextForProfile('read-only') },
    ),
  ).rejects.toThrow();
  await expect(
    tools.execute('skill.create', { name: '../escape', instructions: 'No escape' }, context),
  ).rejects.toThrow();
});
