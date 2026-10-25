// Actual SDK component fixture, NOT a helper codec or a replacement WS client.
// Execute only in the reviewed Docker private NET/FS namespace after source/ELF review.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { readFile, readlink, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = 38473;
const CALL = 'rtc_fixture_A'; // Explicit pre-registration; HTTP attempts/creates must stay ZERO.
const EXPECTED = new Map([
  ['B', `B result: ${'🙂'.repeat(260)}`],
  ['A', `A result: ${'🌱'.repeat(170)}`],
]);
const state = { preRegisteredCall: CALL, httpAttempts: 0, httpCreates: 0, upgrades: 0,
  authPairObserved: false, sessionCloseFrames: 0, peerCloses: 0, maxChunkBytes: 0, chunks: { A: 0, B: 0 } };
const sockets = new Set();
const peers = new Set();
const frames = [];
const results = new Map();
const transitions = [];
let server;
let wss;
let sdk;
let sdkClosed;
let timer;
let resolvePeer;
let rejectPeer;

function observe(peer, data, binary) {
  try {
    assert.equal(binary, false, 'binary client frame');
    assert.ok(frames.length < 8, 'too many client frames');
    assert.equal(state.sessionCloseFrames, 0, 'control operation after session.close');
    const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    frames.push(frame);
    if (frame.type === 'session.close') {
      assert.deepEqual(Object.keys(frame), ['type']);
      state.sessionCloseFrames++;
      return;
    }
    assert.equal(frame.type, 'delegation.context.append'); // Also rejects session.update.
    assert.deepEqual(Object.keys(frame).sort(), ['channel', 'content', 'delegation_item_id', 'type']);
    assert.equal(frame.channel, 'speakable');
    assert.ok(EXPECTED.has(frame.delegation_item_id), 'wrong delegation ID');
    assert.equal(frame.content.length, 1);
    assert.equal(frame.content[0].type, 'input_text');
    const text = frame.content[0].text;
    assert.equal(typeof text, 'string');
    assert.ok(text.isWellFormed(), 'invalid Unicode chunk');
    const bytes = Buffer.byteLength(text);
    assert.ok(bytes > 0 && bytes <= 500, 'invalid chunk byte bound');
    state.maxChunkBytes = Math.max(state.maxChunkBytes, bytes);
    const id = frame.delegation_item_id;
    if (transitions.at(-1) !== id) transitions.push(id);
    assert.ok(transitions.length <= 2, 'interleaved results');
    results.set(id, (results.get(id) ?? '') + text);
    state.chunks[id]++;
  } catch {
    rejectPeer(new Error('fixture rejected SDK frame'));
    peer.terminate();
  }
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 && args[0] === '--host-netns' && /^net:\[\d+\]$/.test(args[1]), 'host baseline required');
  assert.equal(process.version, 'v24.22.1');
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.geteuid(), 1000);
  assert.equal(process.cwd(), '/run/canary');
  assert.notEqual(await readlink('/proc/self/ns/net'), args[1], 'host network namespace');
  const safeKeys = new Set(['PATH', 'HOME', 'LANG', 'TZ', 'HOSTNAME', 'NODE_VERSION', 'YARN_VERSION']);
  assert.ok(Object.keys(process.env).every((key) => safeKeys.has(key)), 'unexpected environment');
  assert.equal(process.env.HOME, '/run/canary');
  const peerClosed = new Promise((resolve, reject) => { resolvePeer = resolve; rejectPeer = reject; });
  wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  server = createServer((request, response) => {
    state.httpAttempts++;
    response.writeHead(403, { connection: 'close' });
    response.end('HTTP creation is not part of this existing-call component');
    rejectPeer(new Error('unexpected HTTP attempt'));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    try {
      state.upgrades++;
      assert.equal(state.upgrades, 1);
      assert.equal(request.url, `/v1/live/${CALL}`);
      assert.equal(request.headers.host, `127.0.0.1:${PORT}`);
      for (const [name, expected] of [
        ['authorization', 'Bearer fixture-only-no-authority'],
        ['chatgpt-account-id', 'fixture-account'],
        ['x-session-id', 'sdk-ws-fixture-session'],
      ]) {
        assert.equal(request.headers[name], expected, 'wrong synthetic header');
        assert.equal(request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length, 1);
      }
      state.authPairObserved = true;
      wss.handleUpgrade(request, socket, head, (peer) => {
        peers.add(peer);
        peer.on('error', () => rejectPeer(new Error('peer error')));
        peer.on('message', (data, binary) => observe(peer, data, binary));
        peer.on('close', () => {
          peers.delete(peer);
          state.peerCloses++;
          try {
            assert.equal(state.sessionCloseFrames, 1);
            assert.equal(state.peerCloses, 1);
            assert.deepEqual(transitions, ['B', 'A']);
            assert.deepEqual(results, EXPECTED);
            assert.ok(state.chunks.A >= 2 && state.chunks.B >= 2, 'SDK did not split emoji results');
            assert.equal(frames.at(-1).type, 'session.close');
            resolvePeer();
          } catch { rejectPeer(new Error('wire result/close oracle failed')); }
        });
        // No session.started requirement: existing-call joins return after upgrade.
        for (const id of ['A', 'B']) peer.send(JSON.stringify({ type: 'delegation.created',
          item: { type: 'delegation', target: 'client', id,
            content: [{ type: 'input_text', text: `fixture task ${id}` }] } }));
      });
    } catch {
      socket.destroy();
      rejectPeer(new Error('fixture rejected SDK upgrade'));
    }
  });
  const listening = once(server, 'listening');
  server.listen({ host: '127.0.0.1', port: PORT, backlog: 1 });
  await listening;
  const output = openSync('/run/canary/sdk.stdout', 'wx', 0o600);
  let error;
  try {
    error = openSync('/run/canary/sdk.stderr', 'wx', 0o600);
    // Reviewed copied loader + matching NEEDED libraries; no host library directory mount.
    sdk = spawn('/bundle/lib/ld-linux-x86-64.so.2', [
      '--library-path', '/bundle/lib', '/bundle/sdk-ws', '--fixture-port', String(PORT),
    ], { shell: false, cwd: '/run/canary',
      env: { HOME: '/run/canary', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
      stdio: ['ignore', output, error],
    });
    sdkClosed = once(sdk, 'close').then((result) => {
      assert.equal(result[0], 0, 'SDK process failed');
      assert.equal(result[1], null, 'SDK process signalled');
      return result;
    });
  } finally {
    closeSync(output);
    if (error !== undefined) closeSync(error);
  }
  const [[code, signal]] = await Promise.all([sdkClosed, peerClosed]);
  assert.equal(code, 0, 'SDK process failed');
  assert.equal(signal, null);
  assert.equal((await stat('/run/canary/sdk.stderr')).size, 0, 'SDK stderr nonempty');
  assert.ok((await stat('/run/canary/sdk.stdout')).size <= 4096, 'SDK output exceeded bound');
  const report = JSON.parse(await readFile('/run/canary/sdk.stdout', 'utf8'));
  assert.equal(report.component, 'actual-sdk-existing-call-happy-cycle');
  assert.equal(report.upstream, '6aaac694803004a63c6f393d153c96d22521a6b9');
  assert.equal(report.call_id, CALL);
  assert.equal(report.http_creates, 0);
  assert.equal(report.close_calls, 1);
  assert.deepEqual(report.result_order, ['B', 'A']);
  assert.equal(report.typed_events.length, 2);
  for (const [index, id] of ['A', 'B'].entries()) {
    const event = report.typed_events[index];
    assert.deepEqual(Object.keys(event), ['HandoffRequested']);
    assert.equal(event.HandoffRequested.handoff_id, id);
    assert.equal(event.HandoffRequested.item_id, id);
    assert.equal(event.HandoffRequested.input_transcript, `fixture task ${id}`);
  }
  assert.equal(state.httpAttempts, 0);
  assert.equal(state.httpCreates, 0);
  return { v: 1, component: report.component, ...state, typedHandoffs: ['A', 'B'],
    resultOrder: transitions, sdkCloseCalls: report.close_calls,
    actualSdk: true, helperCodecTested: false, authManagerUsed: false };
}

let summary;
try {
  timer = setTimeout(() => {
    sdk?.kill('SIGKILL');
    for (const peer of peers) peer.terminate();
    for (const socket of sockets) socket.destroy();
    process.stderr.write('SDK_WS_COMPONENT_DEADLINE\n');
    process.exit(1);
  }, 10000);
  summary = await main();
} catch {
  process.stderr.write('SDK_WS_HAPPY_CYCLE_FAILED\n');
  process.exitCode = 1;
} finally {
  if (sdk && sdk.exitCode === null && sdk.signalCode === null) sdk.kill('SIGKILL');
  if (sdkClosed) await sdkClosed.catch(() => {});
  for (const peer of peers) peer.terminate();
  for (const socket of sockets) socket.destroy();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (wss) await new Promise((resolve) => wss.close(resolve));
  clearTimeout(timer);
}
if (summary && process.exitCode !== 1) process.stdout.write(`${JSON.stringify(summary)}\n`);
