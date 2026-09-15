import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { workspaceDirectory } from '../config/index.js';
import type { DatabaseStore, RunArtifactRow } from '../memory/db.js';
import { redactText, redactValue } from '../security/redaction.js';
import { assertSafeProjectFile, safePath } from '../workspace/fs.js';

export const runArtifactKinds = [
  'file',
  'diff',
  'test-report',
  'screenshot',
  'citation',
  'deployment-receipt',
] as const;
export type RunArtifactKind = (typeof runArtifactKinds)[number];

export interface RunArtifactCandidate {
  kind: RunArtifactKind;
  title: string;
  mimeType: string;
  workspacePath?: string;
  content?: string;
  externalUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CaptureRunArtifactInput extends RunArtifactCandidate {
  runId: string;
  threadId: string;
  sourceTool: string;
  createdAt?: number;
}

export interface RunArtifactLimits {
  maxContentBytes: number;
  maxMetadataBytes: number;
  maxExternalUrlBytes: number;
}

export const defaultRunArtifactLimits: RunArtifactLimits = {
  maxContentBytes: 10_000_000,
  maxMetadataBytes: 16_000,
  maxExternalUrlBytes: 2_048,
};

const allowedMimeTypes: Record<RunArtifactKind, ReadonlySet<string>> = {
  file: new Set([
    'application/json',
    'application/octet-stream',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/xml',
    'application/yaml',
    'application/zip',
    'audio/mpeg',
    'audio/wav',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/csv',
    'text/html',
    'text/markdown',
    'text/plain',
    'text/xml',
    'video/mp4',
  ]),
  diff: new Set(['text/plain', 'text/x-diff']),
  'test-report': new Set([
    'application/json',
    'application/xml',
    'text/html',
    'text/plain',
    'text/xml',
  ]),
  screenshot: new Set(['image/jpeg', 'image/png', 'image/webp']),
  citation: new Set(['text/uri-list']),
  'deployment-receipt': new Set(['application/json', 'text/plain']),
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertContained(base: string, candidate: string, label: string): void {
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`))
    throw new Error(`${label} escapes artifact storage`);
}

async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  const rootPath = resolve(root);
  const targetPath = safePath(rootPath, target);
  const relativePath = relative(rootPath, targetPath);
  let current = rootPath;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stats = await lstat(current);
    if (stats.isSymbolicLink())
      throw new Error(`Refusing artifact source symbolic link: ${target}`);
  }
}

async function privateDirectory(
  path: string,
  label: string,
  physicalParent?: string,
  create = false,
): Promise<string> {
  if (create)
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) throw new Error(`Refusing artifact ${label} symbolic link`);
  if (!entry.isDirectory()) throw new Error(`Artifact ${label} is not a private directory`);
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    const current = await lstat(path);
    if (
      !opened.isDirectory() ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    )
      throw new Error(`Artifact ${label} changed during validation`);
    const physicalPath = await realpath(path);
    if (physicalParent) assertContained(physicalParent, physicalPath, label);
    await handle.chmod(0o700);
    return physicalPath;
  } finally {
    await handle.close();
  }
}

function normalizedMetadata(
  metadata: Record<string, unknown> | undefined,
  maximum: number,
): Record<string, unknown> {
  const value = metadata ?? {};
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    throw new Error('Artifact metadata must be JSON serializable');
  }
  if (byteLength(raw) > maximum) throw new Error('Artifact metadata exceeds the size limit');
  const redacted = redactValue(value) as Record<string, unknown>;
  if (byteLength(JSON.stringify(redacted)) > maximum)
    throw new Error('Artifact metadata exceeds the size limit');
  return redacted;
}

function normalizedExternalUrl(value: string | undefined, maximum: number): string | null {
  if (value === undefined) return null;
  if (byteLength(value) > maximum) throw new Error('Artifact external URL is too long');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Artifact external URL is invalid');
  }
  if (url.protocol !== 'https:') throw new Error('Artifact external URL must use HTTPS');
  if (url.username || url.password)
    throw new Error('Artifact external URL cannot contain credentials');
  if (url.href.includes('?')) throw new Error('Artifact external URL cannot contain a query');
  if (url.href.includes('#')) throw new Error('Artifact external URL cannot contain a fragment');
  return url.toString();
}

function safeExtension(input: CaptureRunArtifactInput): string {
  const extension = extname(input.workspacePath ?? input.title).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}

function isSanitizedTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/yaml'].includes(mimeType)
  );
}

function redactStoredContent(bytes: Buffer, mimeType: string): Buffer {
  if (!isSanitizedTextMime(mimeType)) return bytes;
  return Buffer.from(redactText(bytes.toString('utf8')), 'utf8');
}

export class RunArtifactRegistry {
  private readonly limits: RunArtifactLimits;
  private readonly runtimeRoot: string;
  private readonly storageRoot: string;

  constructor(
    private readonly root: string,
    private readonly store: DatabaseStore,
    limits: Partial<RunArtifactLimits> = {},
  ) {
    this.limits = { ...defaultRunArtifactLimits, ...limits };
    for (const [name, value] of Object.entries(this.limits))
      if (!Number.isInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive integer`);
    this.runtimeRoot = workspaceDirectory(resolve(root));
    this.storageRoot = resolve(this.runtimeRoot, 'artifacts');
  }

  async capture(input: CaptureRunArtifactInput): Promise<RunArtifactRow> {
    if (!(runArtifactKinds as readonly string[]).includes(input.kind))
      throw new Error(`Unsupported artifact kind: ${String(input.kind)}`);
    const mimeType = input.mimeType.trim().toLowerCase();
    if (!allowedMimeTypes[input.kind].has(mimeType))
      throw new Error(`Unsupported artifact MIME type for ${input.kind}: ${input.mimeType}`);
    const title = redactText(input.title.trim());
    if (!title || byteLength(title) > 240)
      throw new Error('Artifact title is required and must be bounded');
    if (!/^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(input.sourceTool))
      throw new Error('Artifact source tool is invalid');
    if (input.workspacePath !== undefined && input.content !== undefined)
      throw new Error('Artifact must use either workspacePath or inline content, not both');
    const externalUrl = normalizedExternalUrl(input.externalUrl, this.limits.maxExternalUrlBytes);
    if (input.workspacePath === undefined && input.content === undefined && externalUrl === null)
      throw new Error('Artifact requires workspace bytes, inline content, or an external URL');
    let metadata = normalizedMetadata(input.metadata, this.limits.maxMetadataBytes);
    const run = this.store.getRun(input.runId);
    if (!run) throw new Error(`Unknown run: ${input.runId}`);
    if (run.threadId !== input.threadId)
      throw new Error(`Run ${input.runId} does not belong to thread ${input.threadId}`);

    let bytes: Buffer | null = null;
    if (input.workspacePath !== undefined) {
      if (isAbsolute(input.workspacePath))
        throw new Error('Artifact workspace source must be relative');
      await assertNoSymlinkComponents(this.root, input.workspacePath);
      const sourcePath = await assertSafeProjectFile(this.root, input.workspacePath);
      const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stats = await handle.stat();
        if (!stats.isFile())
          throw new Error(`Artifact source is not a regular file: ${input.workspacePath}`);
        if (stats.nlink > 1)
          throw new Error(
            `Refusing to capture hard-linked artifact source: ${input.workspacePath}`,
          );
        if (stats.size > this.limits.maxContentBytes)
          throw new Error('Artifact content exceeds the size limit');
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    } else if (input.content !== undefined) bytes = Buffer.from(input.content, 'utf8');

    if (bytes && bytes.byteLength > this.limits.maxContentBytes)
      throw new Error('Artifact content exceeds the size limit');
    if (bytes) bytes = redactStoredContent(bytes, mimeType);
    if (bytes && bytes.byteLength > this.limits.maxContentBytes)
      throw new Error('Artifact content exceeds the size limit');
    metadata = normalizedMetadata(
      {
        ...metadata,
        contentSanitized: bytes !== null && isSanitizedTextMime(mimeType),
        checksumScope:
          bytes === null
            ? 'external-url'
            : isSanitizedTextMime(mimeType)
              ? 'stored-sanitized-bytes'
              : 'stored-bytes',
      },
      this.limits.maxMetadataBytes,
    );

    const artifactId = randomUUID();
    let storagePath: string | null = null;
    let payload = externalUrl ? Buffer.from(externalUrl, 'utf8') : Buffer.alloc(0);
    if (bytes) {
      payload = bytes;
      storagePath = `artifacts/${input.runId}/${artifactId}${safeExtension(input)}`;
      const destination = safePath(this.runtimeRoot, storagePath);
      assertContained(this.storageRoot, destination, storagePath);
      const physicalRuntimeRoot = await privateDirectory(this.runtimeRoot, 'runtime root');
      const physicalStorageRoot = await privateDirectory(
        this.storageRoot,
        'storage root',
        physicalRuntimeRoot,
        true,
      );
      const physicalRunDirectory = await privateDirectory(
        resolve(destination, '..'),
        'run directory',
        physicalStorageRoot,
        true,
      );
      const destinationHandle = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      let wroteBytes = false;
      try {
        const opened = await destinationHandle.stat();
        const current = await lstat(destination);
        const physicalDestination = await realpath(destination);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          current.isSymbolicLink() ||
          !current.isFile() ||
          current.nlink !== 1 ||
          opened.dev !== current.dev ||
          opened.ino !== current.ino
        )
          throw new Error('Artifact destination is not a private file');
        assertContained(physicalRunDirectory, physicalDestination, storagePath);
        await destinationHandle.chmod(0o600);
        await destinationHandle.writeFile(bytes);
        await destinationHandle.sync();
        wroteBytes = true;
      } finally {
        await destinationHandle.close();
        if (!wroteBytes) await unlink(destination).catch(() => undefined);
      }
    }

    try {
      return this.store.createRunArtifact({
        id: artifactId,
        runId: input.runId,
        threadId: input.threadId,
        kind: input.kind,
        title,
        mimeType,
        byteSize: payload.byteLength,
        sha256: createHash('sha256').update(payload).digest('hex'),
        sourceTool: input.sourceTool,
        metadata,
        externalUrl,
        storagePath,
        createdAt: input.createdAt ?? Date.now(),
      });
    } catch (error) {
      if (storagePath) await unlink(safePath(this.runtimeRoot, storagePath)).catch(() => undefined);
      throw error;
    }
  }

  async readStored(artifact: RunArtifactRow): Promise<Buffer> {
    if (!artifact.storagePath) throw new Error('Artifact has no stored content');
    const normalized = artifact.storagePath.replaceAll('\\', '/');
    const parts = normalized.split('/');
    if (
      isAbsolute(artifact.storagePath) ||
      parts.length !== 3 ||
      parts[0] !== 'artifacts' ||
      !parts[1] ||
      !parts[2]
    )
      throw new Error('Invalid artifact storage path');
    const path = safePath(this.runtimeRoot, artifact.storagePath);
    const physicalRuntimeRoot = await privateDirectory(this.runtimeRoot, 'runtime root');
    const physicalStorageRoot = await privateDirectory(
      this.storageRoot,
      'storage root',
      physicalRuntimeRoot,
    );
    const physicalRunDirectory = await privateDirectory(
      resolve(path, '..'),
      'run directory',
      physicalStorageRoot,
    );
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1)
      throw new Error('Artifact storage entry is not a private file');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stats = await handle.stat();
      const current = await lstat(path);
      const resolvedPath = await realpath(path);
      assertContained(physicalRunDirectory, resolvedPath, artifact.storagePath);
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1 ||
        stats.dev !== current.dev ||
        stats.ino !== current.ino
      )
        throw new Error('Artifact storage entry is not a private file');
      if (stats.size !== artifact.byteSize || stats.size > this.limits.maxContentBytes)
        throw new Error('Artifact stored size does not match its immutable record');
      const bytes = await handle.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
        throw new Error('Artifact checksum does not match its immutable record');
      return bytes;
    } finally {
      await handle.close();
    }
  }
}
