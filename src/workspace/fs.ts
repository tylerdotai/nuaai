import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { type Change, diffLines } from 'diff';
import { execa } from 'execa';
import fg from 'fast-glob';

import { defaultRuntimeConfig, workspaceDirectory } from '../config/index.js';
import { sanitizedSubprocessEnvironment } from '../security/environment.js';

const SAFE_COMMANDS = new Set([
  'cat',
  'df',
  'echo',
  'free',
  'printf',
  'ps',
  'pwd',
  'date',
  'head',
  'stat',
  'tail',
  'uname',
  'wc',
  'which',
  'uptime',
  'whoami',
]);

const PROTECTED_WORKSPACE_FILE =
  /(?:^|\/)(?:config\.json|runtime\.json|daemon\.lock|matrix-since\.txt|(?:plugins|skills|secrets)(?:\/.*)?|(?:[^/]*\.(?:env|key|pem|p12|pfx)|[^/]*(?:pass(?:word)?|token|secret|since)[^/]*|[^/]*\.db(?:-(?:shm|wal))?|[^/]*\.sqlite(?:-(?:shm|wal))?|[^/]*\.lock))$/i;
const PATH_READING_COMMANDS = new Set(['cat', 'date', 'df', 'head', 'stat', 'tail', 'wc']);
const PROTECTED_PROJECT_BASENAME =
  /^(?:\.env(?:\.(?!example$|sample$|template$).+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials?(?:\.(?:json|ya?ml|txt|env))?|secrets?(?:\.(?:json|ya?ml|txt|env))?|tokens?(?:\.(?:json|txt|env))?|pass(?:word|wd)?(?:\.(?:json|txt|env))?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i;

export function isProtectedWorkspaceFile(relativePath: string): boolean {
  return PROTECTED_WORKSPACE_FILE.test(relativePath.replaceAll('\\', '/'));
}

function isProtectedProjectFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const projectBasename = basename(normalized);
  return (
    normalized === '.nuaai' ||
    normalized.startsWith('.nuaai/') ||
    normalized === '.git' ||
    normalized.startsWith('.git/') ||
    PROTECTED_PROJECT_BASENAME.test(projectBasename) ||
    /\.(?:key|pem|p12|pfx)$/i.test(projectBasename)
  );
}

function assertAgentProjectFile(relativePath: string): void {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized === '.nuaai' || normalized.startsWith('.nuaai/')) {
    const runtimeRelative = normalized.slice('.nuaai/'.length) || '.nuaai';
    throw new Error(`Protected workspace file: ${runtimeRelative}`);
  }
  if (isProtectedProjectFile(normalized)) throw new Error(`Protected project file: ${normalized}`);
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

export async function assertSafeProjectFile(root: string, target: string): Promise<string> {
  const project = await realpath(resolve(root));
  const path = await assertSafeExistingPath(project, target);
  const projectRelative = relative(project, path).replaceAll('\\', '/');
  if (projectRelative) assertAgentProjectFile(projectRelative);
  try {
    const stats = await lstat(path);
    if (stats.isFile() && stats.nlink > 1)
      throw new Error(`Refusing to access hard-linked file: ${projectRelative || target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path;
}

async function assertSafeWriteParent(root: string, parent: string): Promise<void> {
  const base = await realpath(root);
  let current = parent;
  while (true) {
    try {
      const resolved = await realpath(current);
      if (resolved !== base && !resolved.startsWith(`${base}${sep}`))
        throw new Error(`Path escapes workspace: ${parent}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const next = dirname(current);
      if (next === current) throw error;
      current = next;
    }
  }
}

export async function initWorkspace(root = process.cwd()): Promise<string> {
  const directory = workspaceDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const child of ['sessions', 'skills', 'plugins', 'schedules', 'logs', 'cache', 'secrets'])
    await mkdir(resolve(directory, child), { recursive: true, mode: 0o700 });
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
  assertAgentProjectFile(relativePath);
  const path = await assertSafeProjectFile(root, relativePath);
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
  assertAgentProjectFile(relativePath);
  const path = await assertSafeProjectFile(root, relativePath);
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
  assertAgentProjectFile(relativePath);
  const workspace = await realpath(resolve(root));
  const path = safePath(workspace, relativePath);
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink())
      throw new Error(`Refusing to write through symbolic link: ${relativePath}`);
    if (!stats.isFile()) throw new Error(`Not a regular file: ${relativePath}`);
    if (stats.nlink > 1) throw new Error(`Refusing to write hard-linked file: ${relativePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await assertSafeWriteParent(workspace, dirname(path));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafeExistingPath(workspace, relative(workspace, dirname(path)));
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

export async function listWorkspaceFiles(root: string): Promise<string[]> {
  return (
    await fg('**/*', {
      cwd: resolve(root),
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: [
        '.git/**',
        '.nuaai/**',
        'node_modules/**',
        'dist/**',
        'coverage/**',
        'test-results/**',
      ],
    })
  )
    .filter((file) => !isProtectedProjectFile(file))
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
  options: { timeoutMs?: number; allowedCommands?: Set<string>; cancelSignal?: AbortSignal } = {},
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
  if (isAbsolute(executable)) throw new Error(`Absolute command is not allowlisted: ${executable}`);
  const name = executable.split(/[\\/]/).pop() ?? executable;
  if (executable !== name) throw new Error(`Command path is not allowlisted: ${executable}`);
  const allowed = options.allowedCommands ?? SAFE_COMMANDS;
  if (!allowed.has(name)) throw new Error(`Command is not allowlisted: ${name}`);
  if (name === 'date' && invocationArgs.some((argument) => /^(?:-s|--set(?:=|$))/.test(argument)))
    throw new Error('Mutating command options are not supported');

  if (PATH_READING_COMMANDS.has(name)) {
    const project = resolve(root);
    let optionsEnded = false;
    for (const argument of invocationArgs) {
      if (argument === '--') {
        optionsEnded = true;
        continue;
      }
      if (
        !optionsEnded &&
        (/^--(?:file|files-from|files0-from)(?:=|$)/.test(argument) ||
          (name === 'date' && /^(?:-r|--reference)/.test(argument)) ||
          (name === 'date' && /^-f(?:$|.)/.test(argument)))
      )
        throw new Error('Indirect file options are not supported');
      if (!argument || (!optionsEnded && argument.startsWith('-'))) continue;
      const candidate = isAbsolute(argument) ? resolve(argument) : resolve(root, argument);
      if (candidate !== project && !candidate.startsWith(`${project}${sep}`))
        throw new Error(`Path is outside workspace: ${argument}`);
      await assertSafeProjectFile(project, candidate);
    }
  }
  let executionArgs = invocationArgs;
  if (name === 'ps') {
    const selection =
      invocationArgs.length === 0
        ? []
        : invocationArgs.length === 1 && ['-e', '-A'].includes(invocationArgs[0])
          ? invocationArgs
          : invocationArgs.length === 2 &&
              ['-p', '--pid'].includes(invocationArgs[0]) &&
              /^\d+(?:,\d+)*$/.test(invocationArgs[1])
            ? invocationArgs
            : undefined;
    if (!selection) throw new Error('Unsupported ps arguments');
    executionArgs = [...selection, '-o', 'pid=,ppid=,stat=,comm='];
  }
  const result = await execa(executable, executionArgs, {
    cwd: resolve(root),
    env: sanitizedSubprocessEnvironment(),
    extendEnv: false,
    reject: false,
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 1_000_000,
    cancelSignal: options.cancelSignal,
    shell: false,
    windowsHide: true,
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export function textDiff(before: string, after: string): Change[] {
  return diffLines(before, after);
}
