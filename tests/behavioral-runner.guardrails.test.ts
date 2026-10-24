import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  main,
  parseCases,
  parseOptions,
  sanitizeEvidence,
  structuralEvidence,
} from '../scripts/eval-behavior.js';
import { createEvent } from '../src/core/events.js';

// execFile takes an argument vector; never runs a shell.
const exec = promisify(execFile);
const runner = resolve('scripts/eval-behavior.ts');
const hello = {
  id: 'hello',
  prompt: 'hello',
  category: 'greeting',
  requirements: ['Reply normally'],
  forbiddenBehaviors: ['Research'],
};
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function manifest(rows: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'behavioral-runner-'));
  const path = join(root, 'cases.json');
  await writeFile(path, JSON.stringify(rows));
  return { root, path };
}

it('defaults to validation without initializing a provider even with live-looking environment', async () => {
  const { path } = await manifest([hello]);
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', runner, '--manifest', path], {
    env: { ...process.env, NUAAI_TEST_MODE: '1', OLLAMA_BASE_URL: 'http://127.0.0.1:1' },
  });
  const report = JSON.parse(stdout);
  expect(report.mode).toBe('validate');
  expect(report.inferenceExecuted).toBe(false);
  expect(report.cases[0].id).toBe('hello');
  expect(report.overallVerdict).toBe('NOT_EVALUATED');
});

it('requires separate explicit opt-in, provider, and model and rejects unsafe or unbounded options', () => {
  expect(parseOptions(['--provider', 'ollama', '--model', 'fixture']).live).toBe(false);
  for (const args of [
    ['--live'],
    ['--live', '--provider', 'ollama'],
    ['--live', '--model', 'x'],
    ['--worker'],
    ['--provider', 'deterministic'],
    ['--max-turns', '0'],
    ['--max-cases', '21'],
    ['--timeout-ms', 'Infinity'],
    ['--max-output-bytes', '999999999'],
    ['--endpoint', 'https://example.org'],
    ['--endpoint', 'http://user:password@localhost'],
    ['--live', '--provider', 'ollama', '--model', 'x', '--dry-run'],
  ])
    expect(() => parseOptions(args), args.join(' ')).toThrow();
});

it('validates fixtures and authority without dropping rubric metadata', () => {
  const cases = parseCases({
    cases: [{ ...hello, rubric: { note: 'manual' }, allowedOperations: [] }],
  });
  expect(cases[0].rubric).toEqual({ note: 'manual' });
  expect(cases[0].allowedOperations).toEqual([]);
  for (const rows of [
    [hello, hello],
    [{ ...hello, requirements: [] }],
    [{ ...hello, fixtures: { files: { '../escape': 'x' } } }],
    [{ ...hello, fixtures: { files: { '.nuaai/config.json': 'x' } } }],
    [{ ...hello, fixtures: { toolResponses: { 'workspace.command': {} } } }],
    [{ ...hello, allowedOperations: ['workspace.write'] }],
  ])
    expect(() => parseCases(rows)).toThrow();
});

it('uses observed tool status and event ordering rather than final-answer tokens', () => {
  const row = parseCases([
    {
      ...hello,
      structuralChecks: {
        requireSuccessfulTools: ['workspace.read'],
        successfulToolBeforeFinal: true,
        requireFailureThenAlternative: true,
      },
    },
  ])[0];
  const failed = createEvent('tool.failed', { name: 'web.search' });
  const read = createEvent('tool.completed', {
    name: 'workspace.read',
    result: { text: 'evidence' },
  });
  const final = createEvent('run.completed', { output: 'I read the file. PASS.' });
  expect(structuralEvidence(row, [failed, final], 'completed', false).status).toBe('CHECKS_FAILED');
  expect(structuralEvidence(row, [failed, read, final], 'completed', false).status).toBe(
    'CHECKS_SATISFIED',
  );
  expect(structuralEvidence(row, [final, failed, read], 'completed', false).status).toBe(
    'CHECKS_FAILED',
  );
  expect(structuralEvidence(row, [failed, read, final], 'completed', true).status).toBe(
    'CHECKS_FAILED',
  );
  expect(
    structuralEvidence(
      parseCases([{ ...hello, structuralChecks: { noTools: true } }])[0],
      [failed, final],
      'completed',
      false,
    ).status,
  ).toBe('CHECKS_FAILED');
});

it('sanitizes credentials, terminal escapes, and scratch paths in evidence', () => {
  const value = sanitizeEvidence(
    {
      authorization: 'private',
      output: '\u001b[31mBearer abcdefghijk password=hunter2 /scratch/root/a',
      nested: { apiKey: 'secret' },
    },
    '/scratch/root',
  );
  const text = JSON.stringify(value);
  expect(text).not.toContain('private');
  expect(text).not.toContain('abcdefghijk');
  expect(text).not.toContain('hunter2');
  expect(text).not.toContain('\\u001b');
  expect(text).toContain('[SCRATCH]/a');
});

it('normalizes the shared manifest fixture contract and rejects external lanes before inference', async () => {
  const row = {
    ...hello,
    lane: 'controlled',
    fixture: {
      synthetic: true,
      capabilities: ['workspace.read', 'workspace.readAlternate'],
      observations: {
        'workspace.read': { error: 'EIO' },
        'workspace.readAlternate': { content: 'real fixture observation' },
      },
    },
    authority: { readOnly: true, externalWrites: false, destructiveWrites: false },
  };
  const parsed = parseCases([row])[0];
  expect(parsed.allowedOperations).toEqual(['workspace.read', 'workspace.readAlternate']);
  expect(parsed.fixtures?.failTools).toEqual(['workspace.read']);
  expect(parsed.fixtures?.toolResponses['workspace.readAlternate']).toEqual({
    content: 'real fixture observation',
  });
  const { path } = await manifest([
    { ...row, lane: 'external', fixture: { ...row.fixture, synthetic: false } },
  ]);
  await expect(
    main(['--manifest', path, '--live', '--provider', 'ollama', '--model', 'fixture']),
  ).rejects.toThrow('External');
});

it('rejects case overflow or unknown selection before any provider execution', async () => {
  const { path } = await manifest([hello, { ...hello, id: 'second' }]);
  await expect(
    main([
      '--manifest',
      path,
      '--live',
      '--provider',
      'ollama',
      '--model',
      'fixture',
      '--max-cases',
      '1',
    ]),
  ).rejects.toThrow('Case budget');
  await expect(main(['--manifest', path, '--case', 'missing'])).rejects.toThrow('Unknown case');
});

// This is a local protocol fixture, NOT a model-quality/live-inference claim.
async function protocolEndpoint(reply: (turn: number) => unknown) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let turn = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url ?? '', body: JSON.parse(body) });
    res.setHeader('content-type', 'application/x-ndjson');
    if (req.url !== '/api/chat') {
      res.end(JSON.stringify({ embeddings: [] }));
      return;
    }
    res.end(`${JSON.stringify(reply(turn++))}\n`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return { requests, endpoint: `http://127.0.0.1:${address.port}` };
}

it('runs the real provider selection/runtime/tool observation loop in isolated state and never awards semantic PASS', async () => {
  const local = await protocolEndpoint((turn) =>
    turn % 2 === 0
      ? {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'read-1',
                function: { name: 'workspace.read', arguments: { path: 'facts.txt' } },
              },
            ],
          },
          done: true,
        }
      : { message: { content: 'Controlled fixture value: CEDAR-417.' }, done: true },
  );
  const { path, root } = await manifest([
    {
      ...hello,
      id: 'read',
      prompt: 'Read facts.txt and report its value.',
      fixtures: { files: { 'facts.txt': 'CEDAR-417' } },
      structuralChecks: {
        requireSuccessfulTools: ['workspace.read'],
        successfulToolBeforeFinal: true,
      },
    },
  ]);
  const out = join(root, 'evidence.json');
  const { stdout: workerStdout } = await exec(process.execPath, [
    '--import',
    'tsx',
    runner,
    '--worker',
    '--manifest',
    path,
    '--live',
    '--provider',
    'ollama',
    '--model',
    'protocol-fixture-not-a-model',
    '--endpoint',
    local.endpoint,
    '--timeout-ms',
    '3000',
  ]);
  expect(JSON.parse(workerStdout).runStatus).toBe('completed');
  await exec(process.execPath, [
    '--import',
    'tsx',
    runner,
    '--manifest',
    path,
    '--live',
    '--provider',
    'ollama',
    '--model',
    'protocol-fixture-not-a-model',
    '--endpoint',
    local.endpoint,
    '--timeout-ms',
    '3000',
    '--out',
    out,
  ]);
  const report = JSON.parse(await readFile(out, 'utf8'));
  const result = report.cases[0];
  expect(result.runStatus).toBe('completed');
  expect(result.output).toContain('CEDAR-417');
  expect(result.automatic.status).toBe('CHECKS_SATISFIED');
  expect(result.manual.status).toBe('PENDING');
  expect(result.overallVerdict).toBe('REQUIRES_MANUAL_REVIEW');
  expect(result.provenance).toMatchObject({
    facts: 'controlled-fixtures',
    liveWebFacts: false,
    runtime: 'AgentRuntime',
    state: 'isolated-scratch',
  });
  const chats = local.requests.filter((request) => request.url === '/api/chat');
  expect(chats[0].body.model).toBe('protocol-fixture-not-a-model');
  expect(JSON.stringify(chats[1].body.messages)).toContain('CEDAR-417');
  const toolNames = (chats[0].body.tools as Array<{ function: { name: string } }>).map(
    (tool) => tool.function.name,
  );
  expect(toolNames).not.toContain('workspace.command');
  expect(toolNames).not.toContain('workspace.write');
  expect(result.events.some((event: { type: string }) => event.type === 'tool.completed')).toBe(
    true,
  );
}, 15_000);

it('contains oversized provider output and marks incomplete evidence instead of passing', async () => {
  const local = await protocolEndpoint(() => ({
    message: { content: 'x'.repeat(50_000) },
    done: true,
  }));
  const { path } = await manifest([hello]);
  const { stdout } = await exec(process.execPath, [
    '--import',
    'tsx',
    runner,
    '--manifest',
    path,
    '--live',
    '--provider',
    'ollama',
    '--model',
    'protocol-fixture-not-a-model',
    '--endpoint',
    local.endpoint,
    '--timeout-ms',
    '3000',
    '--max-output-bytes',
    '256',
  ]);
  const result = JSON.parse(stdout).cases[0];
  expect(result.runStatus).toBe('failed');
  expect(result.automatic.status).toBe('CHECKS_FAILED');
  expect(result.overallVerdict).toBe('REQUIRES_MANUAL_REVIEW');
  expect(Buffer.byteLength(stdout)).toBeLessThan(12_000);
}, 15_000);

it('never executes provider-proposed external or destructive actions', async () => {
  const local = await protocolEndpoint((turn) =>
    turn % 2 === 0
      ? {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'write-1',
                function: {
                  name: 'workspace.write',
                  arguments: { path: 'facts.txt', content: 'tampered' },
                },
              },
            ],
          },
          done: true,
        }
      : { message: { content: 'The unavailable operation was not performed.' }, done: true },
  );
  const { path } = await manifest([
    { ...hello, allowedOperations: [], structuralChecks: { noTools: true } },
  ]);
  const { stdout } = await exec(process.execPath, [
    '--import',
    'tsx',
    runner,
    '--manifest',
    path,
    '--live',
    '--provider',
    'ollama',
    '--model',
    'protocol-fixture-not-a-model',
    '--endpoint',
    local.endpoint,
    '--timeout-ms',
    '3000',
  ]);
  const result = JSON.parse(stdout).cases[0];
  expect(
    result.events.filter((event: { type: string }) => event.type === 'tool.completed'),
  ).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('"written"');
  expect(result.manual.status).toBe('PENDING');
}, 15_000);
