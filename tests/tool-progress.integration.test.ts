import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { type ToolBudget, ToolRegistry } from '../src/tools/registry.js';

const budget = (): ToolBudget => ({
  maxCalls: 30,
  maxCostUnits: 100,
  calls: 0,
  costUnits: 0,
  callsByTool: new Map(),
});

it('halts repeated unchanged reads but allows the same read when its observed content progresses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-progress-'));
  const tools = new ToolRegistry(root);
  const context = {
    root,
    runId: 'bound-progress-test',
    permissions: permissionContextForProfile('operator'),
    budget: budget(),
  };
  await writeFile(join(root, 'data.txt'), 'unchanged');
  for (let attempt = 0; attempt < 3; attempt += 1)
    await tools.execute('workspace.read', { path: 'data.txt' }, context);
  await expect(
    tools.execute('workspace.read', { path: 'data.txt' }, context),
  ).rejects.toMatchObject({ code: 'TOOL_NO_PROGRESS', executionState: 'not_executed' });
  const progressing = { ...context, budget: budget() };
  for (let version = 0; version < 5; version += 1) {
    await writeFile(join(root, 'data.txt'), `observed version ${version}`);
    expect(await tools.execute('workspace.read', { path: 'data.txt' }, progressing)).toContain(
      `observed version ${version}`,
    );
  }
});

it('does not repeat an identical mutation after an actual post-effect failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-uncertain-'));
  const tools = new ToolRegistry(root);
  tools.register({
    name: 'counter.increment',
    permission: 'write',
    description: 'Integration fixture: append one real counter entry, then fail after the write.',
    governance: {
      owner: 'counter',
      costClass: 'low',
      authMode: 'none',
      sideEffects: 'workspace',
      approval: 'profile',
      maxCallsPerRun: 10,
    },
    parameters: { type: 'object', properties: {} },
    input: z.object({}),
    execute: async () => {
      await appendFile(join(root, 'counter.txt'), 'increment\n');
      throw new Error('Injected failure after the actual append');
    },
  });
  const context = {
    root,
    runId: 'bound-uncertain-test',
    permissions: permissionContextForProfile('operator'),
    budget: budget(),
  };
  await expect(tools.execute('counter.increment', {}, context)).rejects.toThrow(
    'after the actual append',
  );
  await expect(tools.execute('counter.increment', {}, context)).rejects.toMatchObject({
    code: 'TOOL_UNCERTAIN_EFFECT',
    executionState: 'not_executed',
  });
  expect(await readFile(join(root, 'counter.txt'), 'utf8')).toBe('increment\n');
});
