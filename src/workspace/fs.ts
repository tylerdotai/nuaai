import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { type Change, diffLines } from 'diff';
import { execa } from 'execa';
import fg from 'fast-glob';

import { workspaceDirectory } from '../config/index.js';
import { getVersion } from '../version.js';

export function safePath(root: string, target: string): string {
  const base = resolve(root);
  const candidate = resolve(base, target);

  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) {
    throw new Error(`Path escapes workspace: ${target}`);
  }

  return candidate;
}

export async function initWorkspace(root = process.cwd()): Promise<string> {
  const directory = workspaceDirectory(root);
  await mkdir(directory, { recursive: true });
  const configPath = safePath(directory, 'config.json');

  try {
    await access(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    await writeFile(
      configPath,
      `${JSON.stringify({ name: 'NUAI', version: getVersion() }, null, 2)}\n`,
      'utf8',
    );
  }

  return directory;
}

export async function readWorkspaceFile(root: string, relativePath: string): Promise<string> {
  return readFile(safePath(workspaceDirectory(root), relativePath), 'utf8');
}

export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const files = await fg('**/*', {
    cwd: workspaceDirectory(root),
    dot: true,
    onlyFiles: true,
  });
  return files.sort();
}

export async function runWorkspaceCommand(
  command: string,
  args: string[] = [],
  root = process.cwd(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(command, args, {
    cwd: resolve(root),
    reject: false,
  });

  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function textDiff(before: string, after: string): Change[] {
  return diffLines(before, after);
}
