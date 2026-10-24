// Real loopback socket reconstruction and credential middleware, synthetic voice transport only.
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { effectiveRequestOrigin } from '../src/gateway/origin.js';
import { createToken } from '../src/gateway/token.js';
import { type GatewayServices, startServer } from '../src/server.js';
import { VoiceBroker } from '../src/voice/broker.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function socketFixture() {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-independent-origin-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const create = vi.fn(() => ({
    start: async () => 'synthetic-answer',
    stop: async () => {},
    deliver: async () => {},
    interrupt: async () => {},
  }));
  const broker = new VoiceBroker({
    provider: {
      availability: () => ({ available: true, taskMode: 'disabled', interruption: 'unsupported' }),
      create,
    },
    authorize: () => ({
      identitySnapshotId: 'fixture-identity',
      workspaceRoot: root,
      authorityKey: 'fixture-web',
    }),
    admit: () => {
      throw new Error('No task admission authorized by this fixture');
    },
    now: () => 1_000,
  });
  cleanups.push(() => broker.shutdown());
  const secret = 'independent-synthetic-origin-test-secret';
  const token = createToken(
    { sub: 'browser-session', purpose: 'browser-session', exp: 3600 },
    secret,
    1_000,
  );
  const handle = await startServer({
    root,
    port: 0,
    host: '127.0.0.1',
    authSecret: secret,
    now: () => 1_000,
    voice: broker,
    runtime: { subscribe: () => () => {} } as never,
    store: {} as never,
    providers: {} as never,
    scheduler: {} as never,
    skills: {} as never,
    plugins: {} as never,
    secrets: {} as never,
  } as GatewayServices);
  cleanups.push(() => handle.close());
  const host = `127.0.0.1:${handle.port}`;
  let requestId = 0;
  const post = async (
    origin: string,
    extra: string[] = [],
    authenticated = true,
    path = '/nuaai/api/voice/sessions',
  ) => {
    const body = JSON.stringify({
      sessionId: 'session',
      threadId: 'thread',
      requestId: `request-${++requestId}`,
      offer: { type: 'offer', sdp: 'synthetic-offer' },
    });
    const headers: Record<string, string | string[]> = {
      host,
      origin,
      'content-type': 'application/json',
      ...(authenticated ? { cookie: `nuaai_token=${token}` } : {}),
    };
    for (let index = 0; index < extra.length; index += 2) {
      const name = extra[index].toLowerCase();
      const previous = headers[name];
      headers[name] =
        previous === undefined
          ? extra[index + 1]
          : [...(Array.isArray(previous) ? previous : [previous]), extra[index + 1]];
    }
    const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: '127.0.0.1',
          port: handle.port,
          method: 'POST',
          path,
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end(body);
    });
    if (result.status === 201) {
      const value = JSON.parse(result.text);
      await broker.stop(
        createHash('sha256').update(token).digest('hex'),
        value.voice.id,
        value.voice.generation,
      );
    }
    return result;
  };
  return { host, create, post };
}

it('uses actual loopback peer plus one exact https protocol header for mounted authenticated HTTPS origins', async () => {
  const f = await socketFixture();
  expect((await f.post(`http://${f.host}`)).status).toBe(201);
  expect((await f.post(`https://${f.host}`, ['X-Forwarded-Proto', 'https'])).status).toBe(201);
  expect(f.create).toHaveBeenCalledTimes(2);
  const before = f.create.mock.calls.length;
  expect((await f.post(`https://${f.host}`, [], false)).status).toBe(401);
  expect(f.create).toHaveBeenCalledTimes(before);
});

it('rejects scheme, host, port and malformed Origin impostors before provider creation at the real socket boundary', async () => {
  const f = await socketFixture();
  for (const origin of [
    `https://${f.host}`, // No trusted https protocol assertion.
    `http://foreign.invalid:${f.host.split(':')[1]}`,
    'http://127.0.0.1:1',
    'null',
    'malformed-origin',
    `http://user@${f.host}`,
    `http://${f.host}/path`,
    `http://${f.host}#fragment`,
    `http://${f.host}, http://foreign.invalid`,
  ]) {
    expect((await f.post(origin)).status, origin).toBe(403);
  }
  expect(f.create).not.toHaveBeenCalled();
});

it('rejects raw duplicate/list protocol and Origin headers and never trusts forwarded Host', async () => {
  const f = await socketFixture();
  for (const headers of [
    ['X-Forwarded-Proto', 'https', 'X-Forwarded-Proto', 'https'],
    ['X-Forwarded-Proto', 'https,http'],
    ['X-Forwarded-Proto', 'http, https'],
    ['X-Forwarded-Proto', 'HTTPS'],
    ['Origin', `http://${f.host}`],
  ]) {
    expect((await f.post(`http://${f.host}`, headers)).status, headers.join('|')).toBe(403);
  }
  expect(
    (
      await f.post('https://foreign.invalid', [
        'X-Forwarded-Proto',
        'https',
        'X-Forwarded-Host',
        'foreign.invalid',
      ])
    ).status,
  ).toBe(403);
  expect(f.create).not.toHaveBeenCalled();
  expect((await f.post(`http://${f.host}`, ['X-Forwarded-Host', 'foreign.invalid'])).status).toBe(
    201,
  );
  expect(f.create).toHaveBeenCalledTimes(1);
});

it('never upgrades nonloopback or spoofed peers and requires exactly one raw https assertion', () => {
  const headers = [
    'Host',
    'actual.invalid:9443',
    'X-Forwarded-Proto',
    'https',
    'X-Forwarded-Host',
    'attacker.invalid',
    'X-Forwarded-For',
    '127.0.0.1',
  ];
  for (const peer of [undefined, '192.0.2.10', '127.0.0.2', '::ffff:192.0.2.10'])
    expect(effectiveRequestOrigin(peer, headers)).toBe('http://actual.invalid:9443');
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    expect(effectiveRequestOrigin(peer, headers)).toBe('https://actual.invalid:9443');
    expect(effectiveRequestOrigin(peer, [...headers, 'X-Forwarded-Proto', 'https'])).toBe(
      'http://actual.invalid:9443',
    );
    expect(
      effectiveRequestOrigin(peer, [
        'Host',
        'actual.invalid:9443',
        'X-Forwarded-Proto',
        'https,http',
      ]),
    ).toBe('http://actual.invalid:9443');
  }
});
