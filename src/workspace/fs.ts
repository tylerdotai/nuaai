import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import { type Change, diffLines } from 'diff';
import { execa } from 'execa';
import fg from 'fast-glob';

import { defaultRuntimeConfig, workspaceDirectory } from '../config/index.js';

const SAFE_COMMANDS = new Set([
  'node',
  'npm',
  'npx',
  'git',
  'ollama',
  'codex',
  'python',
  'python3',
]);

export function safePath(root: string, target: string): string {
  const base = resolve(root);
  const candidate = resolve(base, target);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`))
    throw new Error(`Path escapes workspace: ${target}`);
  return candidate;
}

export async function assertSafeExistingPath(root: string, target: string): Promise<string> {
  const candidate = safePath(root, target);
  try {
    const resolved = await realpath(candidate);
    const base = await realpath(root);
    if (resolved !== base && !resolved.startsWith(`${base}${sep}`))
      throw new Error(`Path escapes workspace: ${target}`);
    return resolved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
    throw error;
  }
}

export async function initWorkspace(root = process.cwd()): Promise<string> {
  const directory = workspaceDirectory(root);
  for (const child of ['sessions', 'skills', 'plugins', 'schedules', 'logs', 'cache', 'secrets'])
    await mkdir(resolve(directory, child), { recursive: true });
  const configPath = safePath(directory, 'config.json');
  try {
    await access(configPath, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(configPath, `${JSON.stringify(defaultRuntimeConfig(root), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  return directory;
}

export async function readWorkspaceFile(root: string, relativePath: string): Promise<string> {
  const path = await assertSafeExistingPath(workspaceDirectory(root), relativePath);
  const stats = await lstat(path);
  if (!stats.isFile()) throw new Error(`Not a regular file: ${relativePath}`);
  return readFile(path, 'utf8');
}

export async function writeWorkspaceFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = safePath(workspaceDirectory(root), relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
}

export async function listWorkspaceFiles(root: string): Promise<string[]> {
  return (
    await fg('**/*', {
      cwd: workspaceDirectory(root),
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
    })
  ).sort();
}

export async function searchWorkspace(
  root: string,
  query: string,
): Promise<Array<{ file: string; line: number; text: string }>> {
  if (!query.trim()) throw new Error('Search query is required');
  const results: Array<{ file: string; line: number; text: string }> = [];
  for (const file of await listWorkspaceFiles(root)) {
    const content = await readWorkspaceFile(root, file);
    content.split('\n').forEach((text, index) => {
      if (text.toLowerCase().includes(query.toLowerCase()))
        results.push({ file, line: index + 1, text });
    });
  }
  return results.slice(0, 200);
}

export async function runWorkspaceCommand(
  command: string,
  args: string[] = [],
  root = process.cwd(),
  options: { timeoutMs?: number; allowedCommands?: Set<string> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (isAbsolute(command) && command !== process.execPath)
    throw new Error(`Absolute command is not allowlisted: ${command}`);
  const name = command.split(/[\\/]/).pop() ?? command;
  const allowed = options.allowedCommands ?? SAFE_COMMANDS;
  if (command !== process.execPath && !allowed.has(name))
    throw new Error(`Command is not allowlisted: ${name}`);
  const result = await execa(command, args, {
    cwd: resolve(root),
    reject: false,
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 1_000_000,
    shell: false,
    windowsHide: true,
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export function textDiff(before: string, after: string): Change[] {
  return diffLines(before, after);
}
