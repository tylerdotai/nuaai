import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RunArtifactRegistry } from '../src/artifacts/registry.js';
import { createToken } from '../src/gateway/token.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { type GatewayHandle, type GatewayServices, startServer } from '../src/server.js';
import { initWorkspace } from '../src/workspace/fs.js';

const secret = 'artifact-route-test-secret-at-least-32-bytes';
const token = createToken(
  { sub: 'artifact-test', exp: Math.floor(Date.now() / 1_000) + 300 },
  secret,
);
const stores: DatabaseStore[] = [];
const handles: GatewayHandle[] = [];

function gatewayServices(
  root: string,
  store: DatabaseStore,
  artifacts: RunArtifactRegistry,
): GatewayServices {
  const runtime = {
    subscribe: () => () => undefined,
    status: () => ({ activeRuns: 0, queuedRuns: 0, sessions: 1, providers: [] }),
    providerHealth: async () => [],
    listSessions: () => [],
    createSession: () => ({ session: {}, thread: {} }),
    getSession: () => undefined,
    listThreads: () => [],
    listMessages: () => [],
    startRun: () => ({ id: 'run' }),
    resumeRun: () => ({ id: 'run' }),
    cancelRun: () => undefined,
  };
  const empty = { list: () => [], health: () => [], listNames: () => [] };
  return {
    root,
    port: 0,
    host: '127.0.0.1',
    authSecret: secret,
    webRoot: root,
    runtime: runtime as never,
    store,
    artifacts,
    providers: { catalog: async () => ({ providers: [] }) } as never,
    scheduler: { list: () => [], listTasks: () => [] } as never,
    skills: empty as never,
    plugins: empty as never,
    secrets: empty as never,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-artifact-server-'));
  await initWorkspace(root);
  const store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  const created = store.createSession('Artifact routes', 100);
  const run = store.createRun(
    created.thread.id,
    'create report',
    'test',
    'model',
    'route-run',
    101,
  );
  const otherRun = store.createRun(
    created.thread.id,
    'other report',
    'test',
    'model',
    'other-route-run',
    102,
  );
  const artifacts = new RunArtifactRegistry(root, store);
  const stored = await artifacts.capture({
    runId: run.id,
    threadId: created.thread.id,
    kind: 'file',
    title: 'report "safe".txt',
    mimeType: 'text/plain',
    sourceTool: 'custom.tool',
    content: '0123456789',
    metadata: { suite: 'routes' },
    createdAt: 103,
  });
  const citation = await artifacts.capture({
    runId: run.id,
    threadId: created.thread.id,
    kind: 'citation',
    title: 'Reference',
    mimeType: 'text/uri-list',
    sourceTool: 'web.search',
    externalUrl: 'https://example.com/reference',
    createdAt: 104,
  });
  const handle = await startServer(gatewayServices(root, store, artifacts));
  handles.push(handle);
  return {
    baseUrl: `http://127.0.0.1:${handle.port}`,
    run,
    otherRun,
    stored,
    citation,
  };
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: ['Bearer', token].join(' '), ...extra };
}

afterEach(async () => {
  while (handles.length) await handles.pop()?.close();
  for (const store of stores.splice(0)) store.close();
});

describe('authenticated run artifact routes', () => {
  it('lists and gets only public metadata for artifacts owned by one run', async () => {
    const { baseUrl, run, stored, citation } = await fixture();
    const unauthenticated = await fetch(`${baseUrl}/api/runs/${run.id}/artifacts`);
    expect(unauthenticated.status).toBe(401);

    const response = await fetch(`${baseUrl}/api/runs/${run.id}/artifacts`, {
      headers: authHeaders(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { artifacts: Array<Record<string, unknown>> };
    expect(body.artifacts).toEqual([
      expect.objectContaining({
        id: stored.id,
        runId: run.id,
        kind: 'file',
        downloadUrl: `api/runs/${run.id}/artifacts/${stored.id}/download`,
      }),
      expect.objectContaining({
        id: citation.id,
        runId: run.id,
        kind: 'citation',
        externalUrl: 'https://example.com/reference',
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain('storagePath');
    expect(JSON.stringify(body)).not.toContain('.nuaai');

    const detail = await fetch(`${baseUrl}/api/runs/${run.id}/artifacts/${stored.id}`, {
      headers: authHeaders(),
    });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({ id: stored.id, sha256: stored.sha256 });
  });

  it('returns 404 for unknown or cross-run artifact identifiers', async () => {
    const { baseUrl, run, otherRun, stored } = await fixture();
    for (const url of [
      `${baseUrl}/api/runs/missing/artifacts`,
      `${baseUrl}/api/runs/${run.id}/artifacts/missing`,
      `${baseUrl}/api/runs/${otherRun.id}/artifacts/${stored.id}`,
      `${baseUrl}/api/runs/${otherRun.id}/artifacts/${stored.id}/download`,
    ]) {
      const response = await fetch(url, { headers: authHeaders() });
      expect(response.status).toBe(404);
    }
  });

  it('downloads exact stored bytes with safe headers and supports one byte range', async () => {
    const { baseUrl, run, stored } = await fixture();
    const url = `${baseUrl}/api/runs/${run.id}/artifacts/${stored.id}/download`;
    const response = await fetch(url, { headers: authHeaders() });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('content-length')).toBe('10');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    await expect(response.text()).resolves.toBe('0123456789');

    const range = await fetch(url, { headers: authHeaders({ range: 'bytes=2-5' }) });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(range.headers.get('content-length')).toBe('4');
    await expect(range.text()).resolves.toBe('2345');
  });

  it('returns 416 for malformed or unsatisfiable ranges and 404 for external-only downloads', async () => {
    const { baseUrl, run, stored, citation } = await fixture();
    const url = `${baseUrl}/api/runs/${run.id}/artifacts/${stored.id}/download`;
    for (const range of ['bytes=99-100', 'bytes=5-2', 'items=0-1', 'bytes=0-1,3-4']) {
      const response = await fetch(url, { headers: authHeaders({ range }) });
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */10');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }

    const external = await fetch(
      `${baseUrl}/api/runs/${run.id}/artifacts/${citation.id}/download`,
      { headers: authHeaders() },
    );
    expect(external.status).toBe(404);
  });
});
