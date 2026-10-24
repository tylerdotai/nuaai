import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';

it('does not expose other agent or SSH credential stores by guessing a direct path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-private-path-'));
  const tools = new ToolRegistry(root);
  for (const directory of ['.hermes', '.codex', '.ssh', '.gnupg']) {
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, 'auth.json'), 'PRIVATE_FIXTURE_DATA');
    const context = { root, permissions: permissionContextForProfile('operator') };
    await expect(
      tools.execute('workspace.read', { path: `${directory}/auth.json` }, context),
    ).rejects.toThrow(/protected/i);
    await expect(
      tools.execute('workspace.write', { path: `${directory}/auth.json`, content: 'no' }, context),
    ).rejects.toThrow(/protected/i);
    await expect(
      tools.execute('workspace.trash', { path: `${directory}/auth.json` }, context),
    ).rejects.toThrow(/protected/i);
  }
});
