import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { RunArtifactRegistry } from '../src/artifacts/registry.js';
import { workspaceDirectory } from '../src/config/index.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { initWorkspace } from '../src/workspace/fs.js';

const stores: DatabaseStore[] = [];

async function fixture(options: { maxContentBytes?: number; maxMetadataBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-artifacts-'));
  await initWorkspace(root);
  const store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  const created = store.createSession('Artifacts', 100);
  const run = store.createRun(
    created.thread.id,
    'build a report',
    'deterministic',
    'local-test',
    'artifact-run',
    101,
  );
  const registry = new RunArtifactRegistry(root, store, options);
  return { root, store, run, thread: created.thread, registry };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('durable run artifact persistence', () => {
  it('migrates existing databases and supports create, read, list, and delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-artifact-migration-'));
    await mkdir(workspaceDirectory(root), { recursive: true });
    const legacy = new Database(join(workspaceDirectory(root), 'memory.db'));
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '3');
    `);
    legacy.close();

    const database = openAppDatabase(root);
    const store = new DatabaseStore(database);
    stores.push(store);
    expect(
      (
        database.raw
          .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
          .get() as {
          value: string;
        }
      ).value,
    ).toBe('5');
    expect(
      (
        database.raw.prepare('PRAGMA table_info(run_artifacts)').all() as Array<{ name: string }>
      ).map((column) => column.name),
    ).toEqual(
      expect.arrayContaining([
        'id',
        'run_id',
        'thread_id',
        'kind',
        'title',
        'mime_type',
        'byte_size',
        'sha256',
        'source_tool',
        'metadata',
        'external_url',
        'storage_path',
        'created_at',
      ]),
    );

    const created = store.createSession('Migrated artifacts', 1);
    const run = store.createRun(created.thread.id, 'input', 'test', 'model', 'migration-run', 2);
    const artifact = store.createRunArtifact({
      id: 'artifact-stable-id',
      runId: run.id,
      threadId: created.thread.id,
      kind: 'citation',
      title: 'Source',
      mimeType: 'text/uri-list',
      byteSize: 20,
      sha256: 'a'.repeat(64),
      sourceTool: 'web.search',
      metadata: { source: 'test' },
      externalUrl: 'https://example.com/',
      storagePath: null,
      createdAt: 3,
    });
    expect(store.getRunArtifact(artifact.id)).toEqual(artifact);
    expect(store.listRunArtifacts(run.id)).toEqual([artifact]);
    expect(store.listThreadRunArtifacts(created.thread.id)).toEqual([artifact]);
    expect(store.deleteRunArtifact(artifact.id)).toBe(true);
    expect(store.getRunArtifact(artifact.id)).toBeUndefined();
  });

  it('copies workspace bytes immutably with a stable checksum and redacted provenance', async () => {
    const { root, store, run, thread, registry } = await fixture();
    await writeFile(join(root, 'reports.txt'), 'token=sk-12345678\npassed\n');

    const artifact = await registry.capture({
      runId: run.id,
      threadId: thread.id,
      kind: 'test-report',
      title: 'Suite sk-12345678',
      mimeType: 'text/plain',
      sourceTool: 'workspace.write',
      workspacePath: 'reports.txt',
      metadata: { token: 'private', note: 'Bearer abc.def' },
      createdAt: 200,
    });

    expect(artifact.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(artifact.title).toBe('Suite [REDACTED]');
    expect(artifact.metadata).toEqual({
      token: '[REDACTED]',
      note: 'Bearer [REDACTED]',
      contentSanitized: true,
      checksumScope: 'stored-sanitized-bytes',
    });
    expect(artifact.storagePath).toMatch(new RegExp(`^artifacts/${run.id}/`));
    const storedPath = join(workspaceDirectory(root), artifact.storagePath as string);
    const stored = await readFile(storedPath);
    expect(stored.toString()).toBe('token=[REDACTED]\npassed\n');
    expect(artifact.byteSize).toBe(stored.byteLength);
    expect(artifact.sha256).toBe(createHash('sha256').update(stored).digest('hex'));
    expect((await lstat(storedPath)).mode & 0o777).toBe(0o600);

    await writeFile(join(root, 'reports.txt'), 'changed');
    expect(await readFile(storedPath, 'utf8')).toBe('token=[REDACTED]\npassed\n');
    expect(store.listRunArtifacts(run.id)).toEqual([artifact]);
  });

  it('rejects traversal, absolute, symlink, hard-link, and protected runtime sources', async () => {
    const { root, run, thread, registry } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'nuaai-artifact-outside-'));
    await writeFile(join(outside, 'private.txt'), 'private');
    await symlink(join(outside, 'private.txt'), join(root, 'outside-link.txt'));
    await writeFile(join(root, 'ordinary.txt'), 'ordinary');
    await link(join(root, 'ordinary.txt'), join(root, 'ordinary-alias.txt'));
    await writeFile(join(workspaceDirectory(root), 'runtime.json'), '{"token":"private"}');
    const capture = (workspacePath: string) =>
      registry.capture({
        runId: run.id,
        threadId: thread.id,
        kind: 'file',
        title: 'Blocked',
        mimeType: 'text/plain',
        sourceTool: 'workspace.write',
        workspacePath,
      });

    await expect(capture('../private.txt')).rejects.toThrow('escapes workspace');
    await expect(capture(join(root, 'ordinary.txt'))).rejects.toThrow('relative');
    await expect(capture('outside-link.txt')).rejects.toThrow('symbolic link');
    await expect(capture('ordinary-alias.txt')).rejects.toThrow('hard-linked');
    await expect(capture('.nuaai/runtime.json')).rejects.toThrow('Protected workspace file');
  });

  it('rejects unsupported kinds, MIME types, oversized metadata, and oversized content', async () => {
    const { run, thread, registry } = await fixture({ maxContentBytes: 16, maxMetadataBytes: 32 });
    const base = {
      runId: run.id,
      threadId: thread.id,
      title: 'Result',
      sourceTool: 'custom.tool',
      content: 'ok',
    };

    await expect(
      registry.capture({ ...base, kind: 'archive' as 'file', mimeType: 'text/plain' }),
    ).rejects.toThrow('Unsupported artifact kind');
    await expect(
      registry.capture({ ...base, kind: 'file', mimeType: 'application/x-executable' }),
    ).rejects.toThrow('Unsupported artifact MIME type');
    await expect(
      registry.capture({ ...base, kind: 'file', mimeType: 'text/plain', content: 'x'.repeat(17) }),
    ).rejects.toThrow('content exceeds');
    await expect(
      registry.capture({
        ...base,
        kind: 'file',
        mimeType: 'text/plain',
        metadata: { note: 'x'.repeat(64) },
      }),
    ).rejects.toThrow('metadata exceeds');
  });

  it('accepts only bounded credential-free HTTPS external URLs', async () => {
    const { run, thread, registry } = await fixture();
    const capture = (externalUrl: string) =>
      registry.capture({
        runId: run.id,
        threadId: thread.id,
        kind: 'citation',
        title: 'Source',
        mimeType: 'text/uri-list',
        sourceTool: 'web.search',
        externalUrl,
      });

    await expect(capture('http://example.com')).rejects.toThrow('HTTPS');
    await expect(capture('file:///etc/passwd')).rejects.toThrow('HTTPS');
    await expect(capture('https://user:pass@example.com')).rejects.toThrow('credentials');
    await expect(capture(`https://example.com/${'x'.repeat(2_100)}`)).rejects.toThrow('too long');

    const artifact = await capture('https://example.com/reference');
    expect(artifact).toMatchObject({
      kind: 'citation',
      externalUrl: 'https://example.com/reference',
      storagePath: null,
      byteSize: Buffer.byteLength('https://example.com/reference'),
      sha256: createHash('sha256').update('https://example.com/reference').digest('hex'),
    });
  });

  it('requires artifacts to remain bound to an existing run and its one thread', async () => {
    const { store, run, thread, registry } = await fixture();
    const other = store.createSession('Other', 300);

    await expect(
      registry.capture({
        runId: run.id,
        threadId: other.thread.id,
        kind: 'file',
        title: 'Wrong thread',
        mimeType: 'text/plain',
        sourceTool: 'custom.tool',
        content: 'no',
      }),
    ).rejects.toThrow('does not belong');
    await expect(
      registry.capture({
        runId: 'missing-run',
        threadId: thread.id,
        kind: 'file',
        title: 'Missing',
        mimeType: 'text/plain',
        sourceTool: 'custom.tool',
        content: 'no',
      }),
    ).rejects.toThrow('Unknown run');
  });
});
