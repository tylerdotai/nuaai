import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { type Change, diffLines } from 'diff';
import { execa } from 'execa';
import fg from 'fast-glob';

import { defaultRuntimeConfig, workspaceDirectory } from '../config/index.js';

const SAFE_COMMANDS = new Set([
  'cat',
  'df',
  'echo',
  'free',
  'hostname',
  'lscpu',
  'ls',
  'lsblk',
  'lspci',
  'lsusb',
  'printf',
  'ps',
  'pwd',
  'date',
  'file',
  'head',
  'stat',
  'tail',
  'uname',
  'wc',
  'which',
  'node',
  'npm',
  'npx',
  'git',
  'ollama',
  'codex',
  'python',
  'python3',
  'uptime',
  'whoami',
]);

const PROTECTED_WORKSPACE_FILE =
  /(?:^|\/)(?:config\.json|runtime\.json|daemon\.lock|matrix-since\.txt|secrets(?:\/|$)|(?:[^/]*\.(?:env|key|pem|p12|pfx)|[^/]*(?:pass(?:word)?|token|secret|since)[^/]*|[^/]*\.db(?:-(?:shm|wal))?|[^/]*\.sqlite(?:-(?:shm|wal))?|[^/]*\.lock))$/i;
const PATH_READING_COMMANDS = new Set(['cat', 'file', 'head', 'stat', 'tail', 'wc']);
const INLINE_INTERPRETER_FLAGS = new Set(['-c', '--eval', '-e', '--print', '-p']);

export function isProtectedWorkspaceFile(relativePath: string): boolean {
  return PROTECTED_WORKSPACE_FILE.test(relativePath.replaceAll('\\', '/'));
}

function assertAgentWorkspaceFile(relativePath: string): void {
  if (isProtectedWorkspaceFile(relativePath))
    throw new Error(`Protected workspace file: ${relativePath}`);
}

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
  assertAgentWorkspaceFile(relativePath);
  const path = await assertSafeExistingPath(workspaceDirectory(root), relativePath);
  const stats = await lstat(path);
  if (!stats.isFile()) throw new Error(`Not a regular file: ${relativePath}`);
  return readFile(path, 'utf8');
}

export async function inspectWorkspaceFile(
  root: string,
  relativePath: string,
): Promise<{
  path: string;
  size: number;
  extension: string;
  mimeType: string;
  textPreview?: string;
}> {
  assertAgentWorkspaceFile(relativePath);
  const path = await assertSafeExistingPath(workspaceDirectory(root), relativePath);
  const stats = await lstat(path);
  if (!stats.isFile()) throw new Error(`Not a regular file: ${relativePath}`);
  const extension = extname(relativePath).toLowerCase();
  const textLike = new Set([
    '.c',
    '.cfg',
    '.css',
    '.csv',
    '.html',
    '.ini',
    '.js',
    '.json',
    '.md',
    '.mjs',
    '.py',
    '.sh',
    '.sql',
    '.svg',
    '.toml',
    '.ts',
    '.tsx',
    '.txt',
    '.yaml',
    '.yml',
  ]);
  const mimeTypes: Record<string, string> = {
    '.csv': 'text/csv',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.gif': 'image/gif',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.txt': 'text/plain',
    '.wav': 'audio/wav',
    '.webp': 'image/webp',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
  };
  return {
    path: relativePath,
    size: stats.size,
    extension,
    mimeType: mimeTypes[extension] ?? 'application/octet-stream',
    ...(textLike.has(extension)
      ? { textPreview: (await readFile(path, 'utf8')).slice(0, 16_000) }
      : {}),
  };
}

export async function writeWorkspaceFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  assertAgentWorkspaceFile(relativePath);
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
  )
    .filter((file) => !isProtectedWorkspaceFile(file))
    .sort();
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
  const tokens: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (quote === 'single' && character === "'") {
      quote = undefined;
    } else if (quote === 'double' && character === '"') {
      quote = undefined;
    } else if (!quote && character === "'") {
      quote = 'single';
    } else if (!quote && character === '"') {
      quote = 'double';
    } else if (!quote && /[;&|<>]/.test(character)) {
      throw new Error('Shell operators are not supported; pass command arguments separately');
    } else if (!quote && /\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
    } else {
      token += character;
    }
  }
  if (escaped || quote) throw new Error('Unterminated command escape or quote');
  if (token) tokens.push(token);
  const executable = tokens.shift();
  if (!executable) throw new Error('Command is required');
  const invocationArgs = [...tokens, ...args];
  if (isAbsolute(executable) && executable !== process.execPath)
    throw new Error(`Absolute command is not allowlisted: ${executable}`);
  const name = executable.split(/[\\/]/).pop() ?? executable;
  const allowed = options.allowedCommands ?? SAFE_COMMANDS;
  if (executable !== process.execPath && !allowed.has(name))
    throw new Error(`Command is not allowlisted: ${name}`);
  if (
    executable !== process.execPath &&
    (name === 'node' || name === 'python' || name === 'python3') &&
    invocationArgs.some((argument) => INLINE_INTERPRETER_FLAGS.has(argument))
  )
    throw new Error('Inline interpreter execution is not supported; use workspace file tools');
  if (PATH_READING_COMMANDS.has(name)) {
    const workspace = resolve(workspaceDirectory(root));
    for (const argument of invocationArgs) {
      if (!argument || argument.startsWith('-')) continue;
      const candidate = isAbsolute(argument) ? resolve(argument) : resolve(root, argument);
      if (candidate === workspace || candidate.startsWith(`${workspace}${sep}`)) {
        const relativePath = relative(workspace, candidate);
        if (relativePath && isProtectedWorkspaceFile(relativePath))
          throw new Error(`Protected workspace file: ${relativePath}`);
      }
    }
  }
  const result = await execa(executable, invocationArgs, {
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
