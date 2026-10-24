import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Protocol fixture exercises real adapters/runtime. It is not a live model or semantic evaluator.
const exec = promisify(execFile);
async function fixtureRun(
  id: string,
  calls: Array<{ name: string; args: Record<string, unknown> }>,
) {
  const rows = JSON.parse(await readFile('evals/behavioral/cases.json', 'utf8'));
  const row = rows.find((entry: { id: string }) => entry.id === id);
  if (!row) throw new Error(`Missing shared fixture ${id}`);
  const root = await mkdtemp(join(tmpdir(), 'behavioral-runner-shared-'));
  const manifest = join(root, 'cases.json');
  await writeFile(manifest, JSON.stringify([row]));
  let turn = 0;
  const protocolRequests: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.setHeader('content-type', 'application/x-ndjson');
    if (req.url !== '/api/chat') {
      res.end(JSON.stringify({ embeddings: [] }));
      return;
    }
    protocolRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const call = calls[turn++];
    res.end(
      `${JSON.stringify({ done: true, message: call ? { content: '', tool_calls: [{ id: `call-${turn}`, function: { name: call.name, arguments: call.args } }] } : { content: 'Fixture result only; see observations. Simulation-only.' } })}\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address missing');
  try {
    const { stdout } = await exec(process.execPath, [
      '--import',
      'tsx',
      resolve('scripts/eval-behavior.ts'),
      '--live',
      '--manifest',
      manifest,
      '--provider',
      'ollama',
      '--model',
      'protocol-fixture-not-a-model',
      '--endpoint',
      `http://127.0.0.1:${address.port}`,
      '--timeout-ms',
      '3000',
    ]);
    return { ...JSON.parse(stdout).cases[0], protocolRequests };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it('uses shared failure/alternative fixtures as real failed and completed runtime observations', async () => {
  const result = await fixtureRun('tool-alternative-1', [
    { name: 'workspace.read', args: { path: 'docs/status.txt' } },
    { name: 'workspace.readAlternate', args: { path: 'docs/status.txt' } },
  ]);
  const events = result.events as Array<{
    type: string;
    payload: { name?: string; result?: unknown };
  }>;
  expect(
    events.some((event) => event.type === 'tool.failed' && event.payload.name === 'workspace.read'),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === 'tool.completed' && event.payload.name === 'workspace.readAlternate',
    ),
  ).toBe(true);
  expect(JSON.stringify(events)).toContain('release paused: regression R17');
  expect(result.overallVerdict).toBe('REQUIRES_MANUAL_REVIEW');
}, 15_000);

it('fixture-authorized simulated deletion changes only exact in-memory target and verifies via a later read', async () => {
  const result = await fixtureRun('authorized-fixture-1', [
    { name: 'file.list', args: { path: 'fixture://scratch/old-exports' } },
    { name: 'file.delete', args: { path: 'fixture://scratch/old-exports/a.csv' } },
    { name: 'file.list', args: { path: 'fixture://scratch/old-exports' } },
  ]);
  const lists = result.events.filter(
    (event: { type: string; payload: { name?: string } }) =>
      event.type === 'tool.completed' && event.payload.name === 'file.list',
  );
  expect(lists[0].payload.result.files).toEqual(['a.csv', 'b.csv']);
  expect(lists[1].payload.result.files).toEqual(['b.csv']);
  expect(result.fixtureEvidence.simulatedDeleted).toEqual(['fixture://scratch/old-exports/a.csv']);
  expect(result.provenance.liveWebFacts).toBe(false);
  expect(result.manual.status).toBe('PENDING');
}, 15_000);

it('fixture authorization does not permit a different simulated deletion target', async () => {
  const result = await fixtureRun('authorized-fixture-1', [
    { name: 'file.delete', args: { path: 'fixture://scratch/old-exports/b.csv' } },
    { name: 'file.list', args: { path: 'fixture://scratch/old-exports' } },
  ]);
  expect(result.fixtureEvidence.simulatedDeleted).toEqual([]);
  expect(
    result.events.some(
      (event: { type: string; payload: { name?: string } }) =>
        event.type === 'tool.failed' && event.payload.name === 'file.delete',
    ),
  ).toBe(true);
  const list = result.events.find(
    (event: { type: string; payload: { name?: string } }) =>
      event.type === 'tool.completed' && event.payload.name === 'file.list',
  );
  expect(list.payload.result.files).toEqual(['a.csv', 'b.csv']);
}, 15_000);

it('does not disclose a controlled file through a different requested path', async () => {
  const result = await fixtureRun('local-file-1', [
    { name: 'workspace.read', args: { path: 'config/wrong.json' } },
    { name: 'workspace.read', args: { path: 'config/server.json' } },
  ]);
  const reads = result.events.filter(
    (event: { type: string; payload: { name?: string } }) =>
      ['tool.failed', 'tool.completed'].includes(event.type) &&
      event.payload.name === 'workspace.read',
  );
  expect(reads[0].type).toBe('tool.failed');
  expect(JSON.stringify(reads[0].payload)).not.toContain('4317');
  expect(reads[1].payload.result.path).toBe('config/server.json');
  // Reports redact nested JSON text; assert the actual provider-bound observation instead.
  const delivered = result.protocolRequests
    .flatMap((request: { messages: Array<{ role: string; content: string }> }) => request.messages)
    .filter((message: { role: string }) => message.role === 'tool')
    .map((message: { content: string }) => JSON.parse(message.content))
    .find((observation: { path?: string }) => observation.path === 'config/server.json');
  expect(delivered).toEqual({
    path: 'config/server.json',
    content: '{"port":4317,"host":"127.0.0.1"}',
  });
}, 15_000);

it('returns only the requested comparison snapshot and fetched competitor', async () => {
  const result = await fixtureRun('competitor-sloc-1', [
    { name: 'source.count', args: { project: 'NUAAI' } },
    { name: 'web.fetch', args: { url: 'fixture://pi/source' } },
  ]);
  const completed = result.events.filter(
    (event: { type: string }) => event.type === 'tool.completed',
  );
  expect(completed[0].payload.result.snapshot).toEqual({
    project: 'NUAAI',
    revision: 'fixture-nuaai-1',
    sloc: 12000,
    sourceBytes: 480000,
  });
  expect(JSON.stringify(completed[0].payload.result)).not.toContain('fixture-hermes-1');
  expect(completed[1].payload.result.snapshot).toEqual({
    project: 'Pi Coding Agent',
    revision: 'fixture-pi-1',
    sloc: 9000,
    sourceBytes: 360000,
  });
  expect(JSON.stringify(completed[1].payload.result)).not.toContain('fixture-codex-1');
}, 15_000);

it('rejects a different fetched URL without disclosing the known page', async () => {
  const result = await fixtureRun('fact-lookup-1', [
    { name: 'web.fetch', args: { url: 'fixture://unrelated/releases' } },
    { name: 'web.fetch', args: { url: 'fixture://lumen/releases' } },
  ]);
  const fetches = result.events.filter(
    (event: { type: string; payload: { name?: string } }) =>
      ['tool.failed', 'tool.completed'].includes(event.type) && event.payload.name === 'web.fetch',
  );
  expect(fetches[0].type).toBe('tool.failed');
  expect(JSON.stringify(fetches[0])).not.toContain('4.2.1');
  expect(fetches[1].payload.result.content).toContain('stable: 4.2.1');
}, 15_000);
