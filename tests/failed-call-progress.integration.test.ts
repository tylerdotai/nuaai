import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';

it.each(['workspace.read', 'host.command'])(
  'stops repeated unchanged %s failures without declaring an unexecuted action a no-op',
  async (name) => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-failed-progress-'));
    const tools = new ToolRegistry(root);
    const context = {
      root,
      runId: 'failed-progress',
      permissions: permissionContextForProfile('operator'),
      budget: {
        maxCalls: 20,
        maxCostUnits: 100,
        calls: 0,
        costUnits: 0,
        callsByTool: new Map<string, number>(),
      },
    };
    const args =
      name === 'workspace.read'
        ? { path: 'missing.txt' }
        : { command: join(root, 'missing-executable'), args: [] };
    for (let attempt = 0; attempt < 3; attempt += 1)
      await expect(tools.execute(name, args, context)).rejects.toThrow();
    await expect(tools.execute(name, args, context)).rejects.toMatchObject({
      code: 'TOOL_NO_PROGRESS',
      executionState: 'not_executed',
    });
  },
);
