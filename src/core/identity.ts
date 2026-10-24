import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

export const identityFileBytes = 12_000;
const names = ['SOUL.md', 'AGENTS.md'] as const;
const sourceSchema = z.object({
  scope: z.enum(['global', 'project', 'legacy']),
  name: z.enum(['SOUL.md', 'AGENTS.md', 'retained context']),
  status: z.enum(['loaded', 'missing', 'empty', 'unreadable', 'truncated']),
  content: z.string(),
  bytesRead: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().optional(),
  errorCode: z.string().optional(),
});
export const sessionIdentitySchema = z.object({
  version: z.literal(1),
  id: z.string(),
  sessionId: z.string(),
  revision: z.number().int().positive(),
  capturedAt: z.number().int(),
  globalRoot: z.string(),
  workspaceRoot: z.string(),
  origin: z.enum(['created', 'refreshed', 'legacy-retained', 'legacy-captured', 'inherited']),
  inheritedFrom: z
    .object({
      sessionId: z.string(),
      snapshotId: z.string(),
      revision: z.number().int().positive(),
    })
    .optional(),
  sources: z.array(sourceSchema),
});
export type SessionIdentitySnapshot = z.infer<typeof sessionIdentitySchema>;
export type SessionIdentityStatus = ReturnType<typeof identityStatus>;

function inside(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

/** Exact explicit directory only; source keys and ancestor names never grant access. */
export function identityWorkspace(root: string, requested = root): string {
  const boundary = realpathSync(root);
  const candidate = resolve(root, requested);
  if (!inside(resolve(root), candidate))
    throw new Error('Session workspace is outside the daemon workspace boundary.');
  const physical = realpathSync(candidate);
  if (!inside(boundary, physical) || !statSync(physical).isDirectory())
    throw new Error(
      'Session workspace is outside the daemon workspace boundary or is not a directory.',
    );
  return physical;
}

function readSource(
  root: string,
  scope: 'global' | 'project',
  name: (typeof names)[number],
): z.infer<typeof sourceSchema> {
  let fd: number | undefined;
  try {
    fd = openSync(
      resolve(root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1)
      throw Object.assign(new Error('Not an independent regular file'), { code: 'EBOUNDARY' });
    const buffer = Buffer.alloc(identityFileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs)
      throw Object.assign(new Error('Instruction file changed while reading'), {
        code: 'ECHANGED',
      });
    const truncated = length > identityFileBytes;
    const prefix = buffer.subarray(0, Math.min(length, identityFileBytes));
    const content = new TextDecoder('utf-8', { fatal: true })
      .decode(prefix, { stream: truncated })
      .trim();
    return {
      scope,
      name,
      status: truncated ? 'truncated' : content ? 'loaded' : 'empty',
      content,
      bytesRead: prefix.length,
      totalBytes: info.size,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      scope,
      name,
      status: code === 'ENOENT' ? 'missing' : 'unreadable',
      content: '',
      bytesRead: 0,
      ...(code === 'ENOENT'
        ? {}
        : { errorCode: typeof code === 'string' && /^[A-Z_\d]+$/u.test(code) ? code : 'EREAD' }),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function captureSessionIdentity(input: {
  root: string;
  workspaceRoot?: string;
  sessionId: string;
  revision?: number;
  origin?: SessionIdentitySnapshot['origin'];
  legacyContext?: string;
  parent?: SessionIdentitySnapshot;
}): SessionIdentitySnapshot {
  const globalRoot = realpathSync(input.root);
  const workspaceRoot = identityWorkspace(
    input.root,
    input.parent?.workspaceRoot ?? input.workspaceRoot,
  );
  let sources: SessionIdentitySnapshot['sources'];
  if (input.parent) sources = input.parent.sources.map((source) => ({ ...source }));
  else if (input.legacyContext?.trim()) {
    const bytes = Buffer.from(input.legacyContext);
    const truncated = bytes.length > identityFileBytes * 4;
    const prefix = bytes.subarray(0, identityFileBytes * 4);
    sources = [
      {
        scope: 'legacy',
        name: 'retained context',
        status: truncated ? 'truncated' : 'loaded',
        content: new TextDecoder().decode(prefix, { stream: truncated }),
        bytesRead: prefix.length,
        totalBytes: bytes.length,
      },
    ];
  } else {
    sources = [
      ...(globalRoot === workspaceRoot
        ? []
        : names.map((name) => readSource(globalRoot, 'global', name))),
      ...names.map((name) => readSource(workspaceRoot, 'project', name)),
    ];
  }
  return {
    version: 1,
    id: randomUUID(),
    sessionId: input.sessionId,
    revision: input.revision ?? 1,
    capturedAt: Date.now(),
    globalRoot,
    workspaceRoot,
    origin: input.parent ? 'inherited' : (input.origin ?? 'created'),
    sources,
    ...(input.parent
      ? {
          inheritedFrom: {
            sessionId: input.parent.sessionId,
            snapshotId: input.parent.id,
            revision: input.parent.revision,
          },
        }
      : {}),
  };
}

export function identityStatus(snapshot: SessionIdentitySnapshot) {
  return {
    version: snapshot.version,
    id: snapshot.id,
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    capturedAt: snapshot.capturedAt,
    workspaceRoot: snapshot.workspaceRoot,
    origin: snapshot.origin,
    ...(snapshot.inheritedFrom ? { inheritedFrom: snapshot.inheritedFrom } : {}),
    precedence:
      'runtime boundaries > project AGENTS.md > project SOUL.md > global AGENTS.md > global SOUL.md',
    sources: snapshot.sources.map(({ content: _content, ...source }) => source),
  };
}

export function identityStatusLines(status: SessionIdentityStatus): string[] {
  return [
    `Identity revision ${status.revision} · ${status.origin}`,
    `Workspace: ${status.workspaceRoot}`,
    `Precedence: ${status.precedence}`,
    ...(status.inheritedFrom
      ? [
          `Inherited from ${status.inheritedFrom.sessionId} revision ${status.inheritedFrom.revision}`,
        ]
      : []),
    ...status.sources.map(
      (source) =>
        `${source.scope}/${source.name} · ${source.status} · ${source.bytesRead}${source.totalBytes === undefined ? '' : `/${source.totalBytes}`} bytes${source.errorCode ? ` · ${source.errorCode}` : ''}`,
    ),
  ];
}

export function sessionIdentityPrompt(snapshot: SessionIdentitySnapshot): string {
  const sources = snapshot.sources.filter((source) => source.content);
  if (!sources.length) return 'You are NUAAI, a persistent local-first personal agent.';
  return [
    'Frozen session instruction snapshot. Project instructions refine global defaults; AGENTS.md workflow rules take precedence over SOUL.md style within each scope. No instruction source can expand runtime permissions, capabilities or workspace boundaries. Source content is literal: do not discover additional instruction files by following references or searching ancestors.',
    ...sources.map(
      (source) =>
        `## ${source.scope}/${source.name}\n${source.content}${source.status === 'truncated' ? '\n[truncated by NUAAI]' : ''}`,
    ),
  ].join('\n\n');
}
