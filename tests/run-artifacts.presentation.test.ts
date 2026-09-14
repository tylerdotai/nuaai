import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { afterEach, describe, expect, it } from 'vitest';

import { RunArtifactRegistry } from '../src/artifacts/registry.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { ArtifactCards } from '../src/web/components/ArtifactCards.js';
import type { MessageView } from '../src/web/contracts.js';
import { buildThreadPresentation } from '../src/web/presentation.js';
import { initWorkspace } from '../src/workspace/fs.js';

const stores: DatabaseStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-artifact-presentation-'));
  await initWorkspace(root);
  const store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  const created = store.createSession('Presentation', 100);
  const run = store.createRun(
    created.thread.id,
    'make artifacts',
    'test',
    'model',
    'present-run',
    101,
  );
  const user = store.addMessage(created.thread.id, 'user', 'make artifacts', 'test', 'model', 102);
  store.storeMessageArtifact(user.id, 'run_link', { runId: run.id }, 102);
  const assistant = store.addMessage(
    created.thread.id,
    'assistant',
    'Artifacts ready.',
    'test',
    'model',
    110,
  );
  store.storeMessageArtifact(assistant.id, 'run_link', { runId: run.id }, 110);
  store.updateRun(run.id, { status: 'completed', output: 'Artifacts ready.' }, 111);
  const artifacts = new RunArtifactRegistry(root, store);
  const file = await artifacts.capture({
    runId: run.id,
    threadId: created.thread.id,
    kind: 'test-report',
    title: 'Unit tests.json',
    mimeType: 'application/json',
    sourceTool: 'custom.report',
    content: '{"passed":true}',
    createdAt: 108,
  });
  const citation = await artifacts.capture({
    runId: run.id,
    threadId: created.thread.id,
    kind: 'citation',
    title: 'Primary source',
    mimeType: 'text/uri-list',
    sourceTool: 'web.search',
    externalUrl: 'https://example.com/source',
    createdAt: 109,
  });
  return { store, thread: created.thread, run, file, citation };
}

describe('run artifact presentation contract', () => {
  it('ties downloadable artifacts and distinct citations to the assistant run after reload', async () => {
    const { store, thread, run, file, citation } = await fixture();

    const presentation = buildThreadPresentation(store, thread.id);
    expect(presentation.messages[0]).toMatchObject({ role: 'user', artifacts: [], citations: [] });
    expect(presentation.messages[1]).toMatchObject({
      role: 'assistant',
      runId: run.id,
      artifacts: [
        {
          type: 'artifact',
          id: file.id,
          runId: run.id,
          kind: 'test-report',
          title: 'Unit tests.json',
          mimeType: 'application/json',
          byteSize: file.byteSize,
          sha256: file.sha256,
          sourceTool: 'custom.report',
          createdAt: 108,
          downloadUrl: `api/runs/${run.id}/artifacts/${file.id}/download`,
        },
      ],
      citations: [
        {
          id: citation.id,
          title: 'Primary source',
          url: 'https://example.com/source',
        },
      ],
    });
  });

  it('projects an unknown persisted kind as a generic unsupported item without metadata leakage', async () => {
    const { store, thread, run } = await fixture();
    store.database.raw.pragma('ignore_check_constraints = ON');
    store.database.raw
      .prepare(
        'INSERT INTO run_artifacts (id, run_id, thread_id, kind, title, mime_type, byte_size, sha256, source_tool, metadata, external_url, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'future-artifact',
        run.id,
        thread.id,
        'future-kind',
        'Private future object',
        'application/octet-stream',
        1,
        'b'.repeat(64),
        'future.tool',
        JSON.stringify({ secret: 'must-not-render' }),
        'https://example.com/future',
        null,
        112,
      );

    const assistant = buildThreadPresentation(store, thread.id).messages.find(
      (message) => message.role === 'assistant',
    );
    expect(assistant?.artifacts).toContainEqual({
      type: 'unsupported',
      sourceKind: 'future-kind',
      label: 'This run artifact is not supported in this NUAAI version.',
    });
    expect(JSON.stringify(assistant)).not.toContain('must-not-render');
    expect(JSON.stringify(assistant)).not.toContain('Private future object');
  });
});

describe('PWA artifact cards', () => {
  it('renders working download links, citations, and safe unsupported fallbacks', () => {
    const message: MessageView = {
      id: 'run:run-1:assistant',
      runId: 'run-1',
      role: 'assistant',
      markdown: 'Done',
      createdAt: 100,
      status: 'completed',
      activities: [],
      attachments: [],
      citations: [{ id: 'cite-1', title: 'Primary source', url: 'https://example.com/source' }],
      artifacts: [
        {
          type: 'artifact',
          id: 'artifact-1',
          runId: 'run-1',
          kind: 'file',
          title: 'report.txt',
          mimeType: 'text/plain',
          byteSize: 42,
          sha256: 'c'.repeat(64),
          sourceTool: 'workspace.write',
          createdAt: 101,
          downloadUrl: 'api/runs/run-1/artifacts/artifact-1/download',
        },
        {
          type: 'unsupported',
          sourceKind: 'future-kind',
          label: 'This run artifact is not supported in this NUAAI version.',
        },
      ],
    };

    const markup = renderToStaticMarkup(
      createElement(ArtifactCards, {
        message,
        resolveUrl: (path: string) => `/nuaai/${path.replace(/^\//, '')}`,
      }),
    );
    expect(markup).toContain('Run artifacts');
    expect(markup).toContain('report.txt');
    expect(markup).toContain('42 B');
    expect(markup).toContain('href="/nuaai/api/runs/run-1/artifacts/artifact-1/download"');
    expect(markup).toContain('download="report.txt"');
    expect(markup).toContain('>Download<');
    expect(markup).toContain('Sources');
    expect(markup).toContain('href="https://example.com/source"');
    expect(markup).toContain('rel="noreferrer noopener"');
    expect(markup).toContain('not supported');
    expect(markup).not.toContain('future-kind');
  });
});
