import { mkdtemp } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createToken } from '../src/gateway/token.js';
import { type GatewayServices, startServer } from '../src/server.js';
import { VoiceBroker } from '../src/voice/broker.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-voice-origin-'));
  const create = vi.fn(() => ({
    start: vi.fn(async () => 'fixture-answer'),
    stop: vi.fn(async () => {}),
    deliver: vi.fn(),
    interrupt: vi.fn(),
  }));
  let id = 0;
  const broker = new VoiceBroker({
    provider: {
      availability: () => ({ available: true, taskMode: 'disabled', interruption: 'unsupported' }),
      create,
    },
    authorize: () => ({ identitySnapshotId: 'i1', workspaceRoot: root, authorityKey: 'web' }),
    admit: vi.fn(),
    now: () => 1_000,
    id: () => `voice-${++id}`,
  });
  const secret = 'synthetic-origin-secret-with-at-least-32-bytes';
  const token = createToken(
    { sub: 'browser-session', purpose: 'browser-session', exp: 3600 },
    secret,
    1_000,
  );
  const handle = await startServer({
    root,
    host: '127.0.0.1',
    port: 0,
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
  } satisfies GatewayServices);
  const url = `http://127.0.0.1:${handle.port}`;
  const host = `127.0.0.1:${handle.port}`;
  let requestId = 0;
  const post = async (origin: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}/nuaai/api/voice/sessions`, {
      method: 'POST',
      headers: {
        cookie: `nuaai_token=${token}`,
        origin,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        sessionId: 's1',
        threadId: 't1',
        requestId: `request-${++requestId}`,
        offer: { type: 'offer', sdp: 'fixture-offer' },
      }),
    });
    const body = await response.json();
    if (response.status === 201) {
      await broker.stop(
        (await import('node:crypto')).createHash('sha256').update(token).digest('hex'),
        body.voice.id,
        body.voice.generation,
      );
    }
    return { status: response.status, body };
  };
  return {
    root,
    broker,
    create,
    handle,
    url,
    host,
    token,
    post,
    close: async () => {
      await broker.shutdown();
      await handle.close();
    },
  };
}

describe('real loopback socket voice origin boundary', () => {
  it('accepts matching HTTP and trusted exact HTTPS proxy origin under /nuaai only', async () => {
    const f = await fixture();
    try {
      expect((await f.post(f.url)).status).toBe(201);
      expect((await f.post(`https://${f.host}`, { 'x-forwarded-proto': 'https' })).status).toBe(
        201,
      );
      const before = f.create.mock.calls.length;
      for (const origin of [
        `https://${f.host}`,
        `http://localhost:${f.handle.port}`,
        `http://127.0.0.1:${f.handle.port + 1}`,
        'null',
        'not an origin',
        `${f.url}, ${f.url}`,
        `${f.url}/`,
        `${f.url}#fragment`,
      ]) {
        const rejected = await f.post(origin);
        expect(rejected.status, origin).toBe(403);
        expect(rejected.body).toMatchObject({ error: { code: 'VOICE_FORBIDDEN' } });
      }
      expect(f.create).toHaveBeenCalledTimes(before);
      expect((await f.post(f.url, { 'x-forwarded-proto': 'https' })).status).toBe(403);
      expect(
        (
          await f.post('https://forged.test', {
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'forged.test',
          })
        ).status,
      ).toBe(403);
      expect(
        (await f.post(`https://${f.host}`, { 'x-forwarded-proto': 'https, https' })).status,
      ).toBe(403);
    } finally {
      await f.close();
    }
  });
  it('denies duplicate raw forwarding/origin fields and does not create provider work', async () => {
    const f = await fixture();
    try {
      const raw = (extra: string[]) =>
        new Promise<number>((resolve, reject) => {
          const headers: Record<string, string | string[]> = {
            Host: f.host,
            Cookie: `nuaai_token=${f.token}`,
            'Content-Type': 'application/json',
          };
          for (let index = 0; index < extra.length; index += 2) {
            const name = extra[index];
            const existing = headers[name];
            headers[name] =
              existing === undefined
                ? extra[index + 1]
                : [...(Array.isArray(existing) ? existing : [existing]), extra[index + 1]];
          }
          const request = httpRequest(
            {
              hostname: '127.0.0.1',
              port: f.handle.port,
              path: '/nuaai/api/voice/sessions',
              method: 'POST',
              headers,
            },
            (response) => {
              response.resume();
              response.on('end', () => resolve(response.statusCode ?? 0));
            },
          );
          request.on('error', reject);
          request.end(
            JSON.stringify({
              sessionId: 's1',
              threadId: 't1',
              requestId: 'raw',
              offer: { type: 'offer', sdp: 'fixture-offer' },
            }),
          );
        });
      expect(
        await raw([
          'Origin',
          `https://${f.host}`,
          'X-Forwarded-Proto',
          'https',
          'X-Forwarded-Proto',
          'https',
        ]),
      ).toBe(403);
      expect(await raw(['Origin', f.url, 'Origin', f.url])).toBe(403);
      expect(f.create).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
