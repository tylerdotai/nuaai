import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { discoverFiles } from '../src/workspace/discovery.js';

it('discovers sorted regular files including dotfiles without following file or directory links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-discovery-'));
  const outside = await mkdtemp(join(tmpdir(), 'nuaai-discovery-outside-'));
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, '.project'), 'local');
  await writeFile(join(root, 'src', 'a.ts'), 'first');
  await writeFile(join(root, 'src', 'nested', 'b.ts'), 'second');
  await writeFile(join(outside, 'private.txt'), 'outside');
  await symlink(outside, join(root, 'linked-directory'));
  await symlink(join(outside, 'private.txt'), join(root, 'linked-file'));
  expect(await discoverFiles(root)).toEqual(['.project', 'src/a.ts', 'src/nested/b.ts']);
});

it('supports the fixed one-directory manifest-discovery boundary without a glob parser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-module-discovery-'));
  for (const directory of ['valid', '.hidden', 'valid/nested'])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, 'SKILL.md'), 'root is not a module');
  await writeFile(join(root, 'valid', 'SKILL.md'), 'module');
  await writeFile(join(root, 'valid', 'manifest.json'), '{}');
  await writeFile(join(root, 'valid', 'nested', 'SKILL.md'), 'nested is outside this contract');
  await writeFile(join(root, '.hidden', 'SKILL.md'), 'hidden');
  expect(
    await discoverFiles(root, {
      maxDepth: 1,
      skipDirectory: (path) => path.startsWith('.'),
      includeFile: (path) => path.split('/').length === 2 && path.endsWith('/SKILL.md'),
    }),
  ).toEqual(['valid/SKILL.md']);
  expect(await discoverFiles(root, { maxDepth: 0 })).toEqual(['SKILL.md']);
});

it('prunes excluded trees before traversal but keeps project-local hidden source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-project-discovery-'));
  for (const directory of ['.config', 'src', 'src/node_modules', 'dist'])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, '.config', 'harness.ts'), 'project config');
  await writeFile(join(root, 'src', 'app.ts'), 'project code');
  await writeFile(join(root, 'src', 'node_modules', 'package.js'), 'dependency');
  await writeFile(join(root, 'dist', 'app.js'), 'build');
  const excluded = new Set(['node_modules', 'dist']);
  expect(
    await discoverFiles(root, {
      skipDirectory: (path) => excluded.has(path.split('/').at(-1) ?? ''),
    }),
  ).toEqual(['.config/harness.ts', 'src/app.ts']);
});

it('treats missing discovery roots as empty but propagates non-missing filesystem failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-missing-discovery-'));
  expect(await discoverFiles(join(root, 'missing'))).toEqual([]);
  const file = join(root, 'not-a-directory');
  await writeFile(file, 'regular file');
  await expect(discoverFiles(file)).rejects.toMatchObject({ code: 'ENOTDIR' });
});
