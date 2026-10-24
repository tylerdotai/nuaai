#!/usr/bin/env node
// Installed-byte PTY acceptance. The Python helper is stdlib-only PTY/VT plumbing.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';

const repo = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'nuaai-terminal-smoke-'));
const runtime = join(scratch, 'runtime');
await mkdir(runtime);
const report = resolve(process.env.NUAAI_TERMINAL_REPORT || join(scratch, 'results.json'));
let bin = process.argv[2] && resolve(process.argv[2]);
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 10000000,
    ...options,
  });
}
if (!bin) {
  run('npm', ['run', 'build:release']);
  const output = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch]);
  const start = output.lastIndexOf('\n[');
  const packed = JSON.parse(output.slice(start < 0 ? 0 : start + 1));
  const manifest = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  const install = join(scratch, 'install');
  run(
    'npm',
    [
      'install',
      '--offline',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--prefix',
      install,
      join(scratch, manifest.filename),
    ],
    { env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } },
  );
  bin = join(install, 'node_modules/nuaai/scripts/nuaai.mjs');
}
bin = await realpath(bin);
const env = {
  ...process.env,
  NUAAI_ROOT: runtime,
  NUAAI_HOST: '127.0.0.1',
  NUAAI_TEST_MODE: '1',
  TERM: 'xterm-256color',
  CI: 'false',
  CONTINUOUS_INTEGRATION: 'false',
  FORCE_COLOR: '1',
};
run(process.execPath, [bin, 'init'], { env, cwd: scratch });
const requests = [];
let pending = true;
let crash = false;
const approval = {
  id: 'pty-approval',
  runId: 'pty-run',
  threadId: 'thread',
  toolName: 'workspace.write',
  status: 'pending',
  payloadHash: 'pty-bound-hash',
  target: 'fixture.txt',
  risk: 'write',
  createdAt: 1800000000000,
  expiresAt: 1900000000000,
  providerOwned: false,
  preview: {
    version: 1,
    kind: 'write',
    summary: 'Write controlled fixture only',
    fields: [{ label: 'Proposed text', value: 'PTY fixture\n'.repeat(20) }],
    context: { source: 'tui', client: 'terminal-smoke' },
  },
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  let text = '';
  for await (const chunk of req) text += String(chunk);
  const body = text ? JSON.parse(text) : {};
  requests.push({ method: req.method, path: url.pathname, body });
  let value = {};
  if (url.pathname === '/__smoke/reset') {
    pending = true;
    crash = Boolean(body.crash);
  } else if (url.pathname === '/__smoke/requests') value = requests;
  else if (url.pathname === '/api/sessions' && req.method === 'POST')
    value = {
      session: { id: 'session', title: 'PTY fixture', status: 'active' },
      thread: { id: 'thread', title: 'PTY thread' },
    };
  else if (url.pathname === '/api/sessions')
    value = { sessions: [{ id: 'session', title: 'PTY fixture', status: 'active' }] };
  else if (url.pathname === '/api/sessions/session')
    value = { threads: [{ id: 'thread', title: 'PTY thread' }] };
  else if (url.pathname.endsWith('/presentation'))
    value = { messages: [], nextBefore: null, hasMore: false, eventCursor: 0 };
  else if (url.pathname.endsWith('/run-state')) value = { activeRunId: null, eventCursor: 0 };
  else if (url.pathname === '/api/providers')
    value = {
      active: { name: 'fixture', model: 'no-inference' },
      providers: [
        {
          name: 'fixture',
          available: true,
          detail: 'Controlled HTTP fixture; no inference',
          models: ['no-inference'],
        },
      ],
    };
  else if (url.pathname === '/api/status') value = { ok: true, daemon: true };
  else if (url.pathname === '/api/approvals')
    value = {
      approvals: pending
        ? [
            {
              ...approval,
              expiresAt: crash ? 'invalid-date-for-render-exception' : approval.expiresAt,
            },
          ]
        : [],
    };
  else if (/\/api\/approvals\/pty-approval\/(approve|deny)$/u.test(url.pathname)) {
    pending = false;
    value = { ok: true };
  } else if (url.pathname === '/api/runs' && req.method === 'POST')
    value = { id: 'submitted', threadId: 'thread', status: 'completed', input: body.input };
  else if (url.pathname === '/api/plugins') value = { plugins: [], health: [] };
  else if (url.pathname === '/api/secrets') value = { names: [] };
  else value = { [url.pathname.split('/').at(-1)]: [] };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', (socket) =>
  socket.on('message', () => {
    /* Real WS transport; no unsolicited model events. */
  }),
);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
env.NUAAI_PORT = String(port);
const configPath = join(runtime, '.nuaai/config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.port = port;
config.features = {
  ...config.features,
  ollama: false,
  codex: false,
  matrix: false,
  browser: false,
  search: false,
};
await writeFile(configPath, JSON.stringify(config));
const installedRoot = resolve(dirname(bin), '..');
const artifact = {
  bin,
  version: JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8')).version,
  cliSha256: createHash('sha256')
    .update(await readFile(join(installedRoot, 'dist/cli.js')))
    .digest('hex'),
};
await writeFile(join(scratch, 'artifact.json'), JSON.stringify(artifact));
try {
  const child = spawn(
    'python3',
    [join(import.meta.dirname, 'terminal-smoke.py'), bin, runtime, String(port), report],
    { env, cwd: scratch, stdio: 'inherit' },
  );
  const [code] = await once(child, 'exit');
  const proof = JSON.parse(await readFile(report, 'utf8'));
  await writeFile(report, `${JSON.stringify({ ...proof, artifact }, null, 2)}\n`);
  if (code !== 0) throw new Error(`PTY terminal smoke failed (${code}); evidence: ${report}`);
  const submitted = requests.filter(
    (request) => request.path === '/api/runs' && request.method === 'POST',
  );
  if (!submitted.some((request) => request.body.input === 'é 🇺🇸 界 DONE'))
    throw new Error('Installed PTY did not submit the exact grapheme-edited draft');
  if (
    !requests.some(
      (request) =>
        request.path.endsWith('/pty-approval/deny') &&
        request.body.payloadHash === approval.payloadHash,
    )
  )
    throw new Error('Installed PTY did not deny the bound approval');
  process.stdout.write(`Terminal smoke passed: ${report}\nInstalled CLI: ${bin}\n`);
} finally {
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((done) => sockets.close(done));
  await new Promise((done) => server.close(done));
}
