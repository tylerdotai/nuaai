import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { initWorkspace } from '../src/workspace/fs.js';

it('lists home projects without descending into private runtime or unreadable container state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-home-listing-'));
  const denied = join(root, '.local/share/containers/storage/overlay/denied');
  await mkdir(denied, { recursive: true });
  await mkdir(join(root, '.hermes'), { recursive: true });
  await mkdir(join(root, 'project/.config'), { recursive: true });
  await writeFile(join(root, 'project/.config/harness.ts'), 'export const config = {};');
  await writeFile(join(root, '.hermes/private.md'), 'Private runtime data');
  await chmod(denied, 0);
  try {
    const result = await execa(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { listWorkspaceFiles } from ${JSON.stringify(pathToFileURL(resolve('src/workspace/fs.ts')).href)}; console.log(JSON.stringify(await listWorkspaceFiles(process.env.HOME)));`,
      ],
      { env: { HOME: root }, reject: false, timeout: 10000 },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['project/.config/harness.ts']);
  } finally {
    await chmod(denied, 0o700);
  }
});

it('bounds workspace.list to immediate entries and accepts a returned subdirectory as the next input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-directory-list-'));
  await initWorkspace(root);
  await mkdir(join(root, 'project/unreadable'), { recursive: true });
  await writeFile(join(root, 'project/report.txt'), 'actual report');
  await writeFile(join(root, 'note.txt'), 'top level');
  await chmod(join(root, 'project/unreadable'), 0);
  const registry = new ToolRegistry(root);
  const context = {
    root,
    timeoutMs: 5000,
    permissions: { approved: new Set<'read'>(['read']), capabilities: { filesystem: true } },
  };
  try {
    const first = (await registry.execute('workspace.list', { limit: 1 }, context)) as {
      path: string;
      entries: Array<{ name: string; path: string; type: string }>;
      total: number;
      truncated: boolean;
    };
    expect(first).toMatchObject({ path: '.', total: 2, truncated: true });
    expect(first.entries).toHaveLength(1);
    const all = (await registry.execute('workspace.list', {}, context)) as typeof first;
    const directory = all.entries.find((entry) => entry.type === 'directory');
    expect(directory?.path).toBe('project');
    const second = (await registry.execute(
      'workspace.list',
      { path: directory?.path },
      context,
    )) as typeof first;
    expect(second.entries).toContainEqual({
      name: 'report.txt',
      path: 'project/report.txt',
      type: 'file',
    });
    await expect(
      registry.execute('workspace.list', { path: '../escape' }, context),
    ).rejects.toThrow('escapes workspace');
  } finally {
    await chmod(join(root, 'project/unreadable'), 0o700);
  }
});
