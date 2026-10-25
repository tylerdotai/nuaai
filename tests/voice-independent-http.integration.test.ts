// Synthetic provider with real Hono request/response handling; no remote service or media.
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { VoiceBroker, VoiceError } from '../src/voice/broker.js';
import { installVoiceRoutes } from '../src/voice/http.js';

const brokers: VoiceBroker[] = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.shutdown()));
});
function harness() {
  const create = vi.fn(() => ({
    start: async () => 'synthetic-answer',
    stop: async () => {},
    deliver: async () => {},
    interrupt: async () => {},
  }));
  const broker = new VoiceBroker({
    provider: {
      availability: () => ({ available: true, taskMode: 'daemon', interruption: 'unsupported' }),
      create,
    },
    authorize: () => ({
      identitySnapshotId: 'identity',
      workspaceRoot: '/fixture',
      authorityKey: 'read',
    }),
    admit: () => {
      throw new Error('No task admission expected');
    },
  });
  brokers.push(broker);
  const app = new Hono();
  installVoiceRoutes(app, broker, (request) => {
    if (request.headers.get('cookie') !== 'fixture-cookie')
      throw new VoiceError('VOICE_FORBIDDEN', 403);
    return { owner: 'owner', expiresAt: Date.now() + 60_000 };
  });
  const start = (origin: string, extra: Record<string, unknown> = {}) =>
    app.request('http://127.0.0.1:45678/api/voice/sessions', {
      method: 'POST',
      headers: { cookie: 'fixture-cookie', origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session',
        threadId: 'thread',
        requestId: 'request',
        offer: { type: 'offer', sdp: 'synthetic-offer' },
        ...extra,
      }),
    });
  return { app, start, create };
}

it('rejects unauthenticated capability reads and query-token auth without provider creation', async () => {
  const h = harness();
  const missing = await h.app.request('http://127.0.0.1:45678/api/voice/capabilities');
  expect(missing.status).toBe(403);
  expect(await missing.json()).toMatchObject({ error: { code: 'VOICE_FORBIDDEN' } });
  const queryToken = await h.app.request(
    'http://127.0.0.1:45678/api/voice/capabilities?token=synthetic',
    {
      headers: { cookie: 'fixture-cookie' },
    },
  );
  expect(queryToken.status).toBe(403);
  expect(h.create).not.toHaveBeenCalled();
});

it('rejects cross-host origins and unknown control-plane fields before provider creation', async () => {
  const h = harness();
  expect((await h.start('http://attacker.invalid')).status).toBe(403);
  expect((await h.start('http://127.0.0.1:45678', { billing: 'api-key' })).status).toBe(400);
  expect(h.create).not.toHaveBeenCalled();
});

it('requires exact origin including scheme for cookie-authenticated voice mutation', async () => {
  const h = harness();
  const crossScheme = await h.start('https://127.0.0.1:45678');
  expect(crossScheme.status).toBe(403);
  expect(h.create).not.toHaveBeenCalled();
});

it.each([
  'null',
  'not-an-origin',
  'http://127.0.0.1:45679',
  'http://127.0.0.1:45678,http://attacker.invalid',
  'http://user@127.0.0.1:45678',
  'http://127.0.0.1:45678/path',
  'http://127.0.0.1:45678/#fragment',
])(
  'rejects invalid or mismatched serialized Origin %s before any provider starts',
  async (origin) => {
    const h = harness();
    const rejected = await h.start(origin);
    expect(rejected.status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
  },
);

it('keeps negotiation out of subsequent snapshots and rejects stale generation controls', async () => {
  const h = harness();
  const started = await h.start('http://127.0.0.1:45678');
  expect(started.status).toBe(201);
  expect(started.headers.get('cache-control')).toBe('no-store');
  const result = await started.json();
  expect(result.answer).toEqual({ type: 'answer', sdp: 'synthetic-answer' });
  const snapshot = await h.app.request(
    `http://127.0.0.1:45678/api/voice/sessions/${result.voice.id}`,
    {
      headers: { cookie: 'fixture-cookie' },
    },
  );
  expect(snapshot.status).toBe(200);
  const text = await snapshot.text();
  expect(text).not.toContain('synthetic-answer');
  expect(text).not.toContain('synthetic-offer');
  const stale = await h.app.request(
    `http://127.0.0.1:45678/api/voice/sessions/${result.voice.id}/stop`,
    {
      method: 'POST',
      headers: {
        cookie: 'fixture-cookie',
        origin: 'http://127.0.0.1:45678',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ generation: result.voice.generation + 1, reason: 'hangup' }),
    },
  );
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: 'VOICE_STALE_GENERATION' } });
  expect(h.create).toHaveBeenCalledTimes(1);
});
