import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';

it('performs exact edit, copy, move and recoverable trash through native workspace tools without shell deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-lifecycle-'));
  const tools = new ToolRegistry(root);
  const context = { root, permissions: permissionContextForProfile('operator') };
  const call = (name: string, input: unknown) => tools.execute(name, input, context);
  await call('workspace.write', { path: 'sample.txt', content: 'before\n' });
  await call('workspace.edit', { path: 'sample.txt', oldText: 'before', newText: 'after' });
  expect(await readFile(join(root, 'sample.txt'), 'utf8')).toBe('after\n');
  await expect(
    call('workspace.edit', { path: 'sample.txt', oldText: 'missing', newText: 'bad' }),
  ).rejects.toThrow(/match/i);
  await call('workspace.mkdir', { path: 'nested' });
  await call('workspace.copy', { path: 'sample.txt', destination: 'nested/copied.txt' });
  await expect(
    call('workspace.copy', { path: 'sample.txt', destination: 'nested/copied.txt' }),
  ).rejects.toThrow();
  await call('workspace.move', { path: 'nested/copied.txt', destination: 'nested/moved.txt' });
  expect(await readFile(join(root, 'nested/moved.txt'), 'utf8')).toBe('after\n');
  expect(await call('workspace.stat', { path: 'nested/copied.txt' })).toMatchObject({
    exists: false,
  });
  const receipt = await call('workspace.trash', { path: 'nested/moved.txt' });
  expect(receipt).toMatchObject({ trashed: 'nested/moved.txt', recoverable: true });
  await expect(access(join(root, 'nested/moved.txt'))).rejects.toThrow();
  await expect(call('workspace.trash', { path: 'nested' })).rejects.toThrow(/regular file/i);
  await writeFile(join(root, '.env'), 'fixture-protected');
  await expect(call('workspace.trash', { path: '.env' })).rejects.toThrow(/protected/i);
  const outside = await mkdtemp(join(tmpdir(), 'nuaai-outside-'));
  await writeFile(join(outside, 'keep.txt'), 'keep');
  await symlink(outside, join(root, 'escape'));
  await expect(
    call('workspace.move', { path: 'sample.txt', destination: 'escape/keep.txt' }),
  ).rejects.toThrow(/escapes/i);
  await expect(call('workspace.trash', { path: 'escape/keep.txt' })).rejects.toThrow(/escapes/i);
  expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  await mkdir(join(root, 'ambiguous'));
  await call('workspace.write', { path: 'ambiguous/repeat.txt', content: 'same same' });
  await expect(
    call('workspace.edit', { path: 'ambiguous/repeat.txt', oldText: 'same', newText: 'no' }),
  ).rejects.toThrow(/unique/i);
  await expect(
    tools.execute(
      'workspace.trash',
      { path: 'sample.txt' },
      { root, permissions: permissionContextForProfile('read-only') },
    ),
  ).rejects.toThrow(/permission/i);
});
