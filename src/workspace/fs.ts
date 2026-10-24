import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { type Change, diffLines } from 'diff';
import { execa } from 'execa';
import { type DiscoveryOptions, discoverFiles } from './discovery.js';

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
    /(?:^|\/)(?:\.hermes|\.codex|\.claude|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)(?:\/|$)/.test(
      normalized,
    ) ||
    /(?:^|\/)\.pi\/agent(?:\/|$)/.test(normalized) ||
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

export async function editWorkspaceFile(
  root: string,
  path: string,
  oldText: string,
  newText: string,
): Promise<unknown> {
  const before = await readWorkspaceFile(root, path);
  if (!oldText || !before.includes(oldText)) throw new Error('Edit text does not match the file');
  if (before.indexOf(oldText) !== before.lastIndexOf(oldText))
    throw new Error('Edit requires a unique exact match');
  await writeWorkspaceFile(
    root,
    path,
    before.replace(oldText, () => newText),
  );
  return {
    edited: path,
    sha256: createHash('sha256')
      .update(before.replace(oldText, () => newText))
      .digest('hex'),
  };
}

export async function statWorkspacePath(root: string, path: string): Promise<unknown> {
  const target = await assertSafeProjectFile(root, path);
  try {
    const stat = await lstat(target);
    return { path, exists: true, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, exists: false };
    throw error;
  }
}

export async function mkdirWorkspacePath(root: string, path: string): Promise<unknown> {
  assertAgentProjectFile(path);
  const target = safePath(root, path);
  await assertSafeWriteParent(root, target);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await assertSafeProjectFile(root, path);
  return { created: path };
}

export async function trashWorkspaceFile(root: string, path: string): Promise<unknown> {
  const target = safePath(root, path);
  await assertSafeProjectFile(root, path);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Trash accepts only a regular file, not directories or symbolic links');
  // Freedesktop trash owned by this workspace, not the operator's personal trash.
  const dataHome = safePath(root, '.nuaai/trash');
  await assertSafeWriteParent(root, dataHome);
  await mkdir(dataHome, { recursive: true, mode: 0o700 });
  const result = await execa('gio', ['trash', '--', target], {
    env: { ...sanitizedSubprocessEnvironment(), XDG_DATA_HOME: dataHome },
    extendEnv: false,
    shell: false,
    reject: false,
    timeout: 30_000,
    maxBuffer: 16_000,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `System trash failed; no permanent-delete fallback: ${result.stderr.slice(0, 500)}`,
    );
  return {
    trashed: path,
    recoverable: true,
    recovery: 'Workspace .nuaai/trash/Trash (Freedesktop files and info)',
  };
}

export async function copyWorkspaceFile(
  root: string,
  path: string,
  destination: string,
  move = false,
): Promise<unknown> {
  const source = await assertSafeProjectFile(root, path);
  if (!(await lstat(source)).isFile() || (await lstat(safePath(root, path))).isSymbolicLink())
    throw new Error('Copy/move accepts only a regular file');
  assertAgentProjectFile(destination);
  const target = safePath(root, destination);
  await assertSafeWriteParent(root, dirname(target));
  await assertSafeProjectFile(root, destination);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, 0o600);
  if (move) await trashWorkspaceFile(root, path);
  const sha256 = createHash('sha256')
    .update(await readFile(target))
    .digest('hex');
  return move ? { moved: path, destination, sha256 } : { copied: path, destination, sha256 };
}

export async function listWorkspaceDirectory(
  root: string,
  path = '.',
  limit = 200,
): Promise<{
  path: string;
  entries: Array<{ name: string; path: string; type: 'file' | 'directory' }>;
  total: number;
  truncated: boolean;
}> {
  const directory = await assertSafeProjectFile(root, path);
  const workspace = await realpath(resolve(root));
  const location = relative(workspace, directory).replaceAll('\\', '/') || '.';
  const homeState = new Set([
    '.local',
    '.cache',
    '.config',
    '.hermes',
    '.codex',
    '.claude',
    '.ssh',
    '.gnupg',
    '.npm',
    '.nvm',
    '.mozilla',
    '.var',
    '.docker',
  ]);
  const homeWorkspace = workspace === (await realpath(homedir()));
  if (homeWorkspace && homeState.has(location.split('/')[0]))
    throw new Error('Home application state is excluded from project listing.');
  const omittedDirectories = new Set([
    '.git',
    '.nuaai',
    'node_modules',
    'dist',
    'coverage',
    'test-results',
  ]);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()))
    .filter((entry) => !(entry.isDirectory() && omittedDirectories.has(entry.name)))
    .map((entry) => ({
      name: entry.name,
      path: relative(workspace, resolve(directory, entry.name)).replaceAll('\\', '/'),
      type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
    }))
    .filter(
      (entry) =>
        !isProtectedProjectFile(entry.path) &&
        !(homeWorkspace && homeState.has(entry.path.split('/')[0])),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    path: location,
    entries: entries.slice(0, limit),
    total: entries.length,
    truncated: entries.length > limit,
  };
}

export async function listWorkspaceFiles(
  root: string,
  options: DiscoveryOptions & { path?: string } = {},
): Promise<string[]> {
  options.signal?.throwIfAborted();
  const directory = options.path ? await assertSafeProjectFile(root, options.path) : resolve(root);
  const prefix = relative(resolve(root), directory).replaceAll('\\', '/');
  if (options.path && (await lstat(directory)).isFile()) return [prefix];
  const projectPath = (path: string): string => (prefix ? `${prefix}/${path}` : path);
  // Home application/container state is not project source. Preserve errors in real projects.
  const homeState = new Set(
    resolve(root) === resolve(homedir())
      ? [
          '.local',
          '.cache',
          '.config',
          '.hermes',
          '.codex',
          '.claude',
          '.ssh',
          '.gnupg',
          '.npm',
          '.nvm',
          '.mozilla',
          '.var',
          '.docker',
        ]
      : [],
  );
  const omitted = new Set(['.git', '.nuaai', 'node_modules', 'dist', 'coverage', 'test-results']);
  const files = await discoverFiles(directory, {
    ...options,
    skipDirectory: (path) =>
      homeState.has(projectPath(path).split('/')[0]) ||
      omitted.has(path.split('/').at(-1) ?? '') ||
      isProtectedProjectFile(projectPath(path)) ||
      Boolean(options.skipDirectory?.(path)),
    includeFile: (path) =>
      !isProtectedProjectFile(projectPath(path)) &&
      (!options.includeFile || options.includeFile(path)),
  });
  return files.map(projectPath);
}

export interface WorkspaceSearchOptions {
  path?: string;
  limit?: number;
  maxFileBytes?: number;
  maxBytes?: number;
  maxFiles?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}
export interface WorkspaceSearchResult {
  matches: Array<{ file: string; line: number; text: string }>;
  complete: boolean;
  scannedFiles: number;
  bytesRead: number;
  skipped: Record<'oversized' | 'binary' | 'unreadable', number>;
  warnings: Array<{ file: string; reason: string }>;
  stoppedBecause?: 'match_limit' | 'byte_limit' | 'file_limit' | 'entry_limit';
  limits: Required<Omit<WorkspaceSearchOptions, 'path' | 'signal'>>;
}

export async function searchWorkspace(
  root: string,
  query: string,
  options: WorkspaceSearchOptions = {},
): Promise<WorkspaceSearchResult> {
  if (!query.trim()) throw new Error('Search query is required');
  options.signal?.throwIfAborted();
  const limits = {
    limit: options.limit ?? 200,
    maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
    maxBytes: options.maxBytes ?? 16 * 1024 * 1024,
    maxFiles: options.maxFiles ?? 2000,
    maxEntries: options.maxEntries ?? 10000,
  };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new Error('Search limits must be positive integers');
  const result: WorkspaceSearchResult = {
    matches: [],
    complete: true,
    scannedFiles: 0,
    bytesRead: 0,
    skipped: { oversized: 0, binary: 0, unreadable: 0 },
    warnings: [],
    limits,
  };
  const skip = (file: string, reason: keyof WorkspaceSearchResult['skipped']): void => {
    result.skipped[reason] += 1;
    if (result.warnings.length < 24) result.warnings.push({ file, reason });
  };
  const files = await listWorkspaceFiles(root, {
    path: options.path,
    maxFiles: limits.maxFiles + 1,
    maxEntries: limits.maxEntries,
    signal: options.signal,
    onLimit: (reason) => {
      result.stoppedBecause = reason;
    },
    onError: (file) => skip(file, 'unreadable'),
  });
  const needle = query.toLowerCase();
  search: for (const file of files) {
    options.signal?.throwIfAborted();
    if (result.scannedFiles >= limits.maxFiles) {
      result.stoppedBecause = 'file_limit';
      break;
    }
    result.scannedFiles += 1;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const path = await assertSafeProjectFile(root, file);
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink > 1) {
        skip(file, 'unreadable');
        continue;
      }
      if (stats.size > limits.maxFileBytes) {
        skip(file, 'oversized');
        continue;
      }
      const remaining = limits.maxBytes - result.bytesRead;
      if (remaining < stats.size || remaining === 0) {
        result.stoppedBecause = 'byte_limit';
        break;
      }
      const allowance = Math.min(limits.maxFileBytes + 1, remaining);
      const chunks: Buffer[] = [];
      let size = 0;
      while (size < allowance) {
        options.signal?.throwIfAborted();
        const chunk = Buffer.allocUnsafe(Math.min(65536, allowance - size));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        result.bytesRead += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      options.signal?.throwIfAborted();
      const finalSize = (await handle.stat()).size;
      if (size > limits.maxFileBytes || finalSize > limits.maxFileBytes) {
        skip(file, 'oversized');
        continue;
      }
      if (finalSize > size) {
        result.stoppedBecause = 'byte_limit';
        break;
      }
      const bytes = Buffer.concat(chunks, size);
      if (bytes.includes(0)) {
        skip(file, 'binary');
        continue;
      }
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        skip(file, 'binary');
        continue;
      }
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const found = line.toLowerCase().indexOf(needle);
        if (found < 0) continue;
        const start = Math.max(0, found - 80);
        result.matches.push({
          file,
          line: index + 1,
          text: line.slice(start, Math.max(found + query.length, start + 2000)),
        });
        if (result.matches.length >= limits.limit) {
          result.stoppedBecause = 'match_limit';
          break search;
        }
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (
        options.path &&
        /Protected|escapes workspace|hard-linked/.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        throw error;
      skip(file, 'unreadable');
    } finally {
      await handle?.close();
    }
  }
  result.complete =
    !result.stoppedBecause && Object.values(result.skipped).every((count) => count === 0);
  return result;
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
