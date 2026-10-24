import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceBroker, type VoiceProviderEvent } from '../src/voice/broker.js';
import { unsupportedCodexVoiceProvider } from '../src/voice/codex-transport.js';
import { installVoiceRoutes } from '../src/voice/http.js';
import { voiceLimits } from '../src/voice/types.js';

function fixture(available = true) {
  let event: (value: VoiceProviderEvent) => void = () => {};
  const start = vi.fn(async (_sdp, receive) => {
    event = receive;
    return 'private-answer';
  });
  const stop = vi.fn(async () => {});
  const broker = new VoiceBroker({
    provider: available
      ? {
          availability: () => ({
            available: true,
            taskMode: 'daemon',
            interruption: 'unsupported',
          }),
          create: () => ({ start, stop, deliver: vi.fn(), interrupt: vi.fn() }),
        }
      : unsupportedCodexVoiceProvider,
    authorize: (_owner, binding) => {
      if (binding.sessionId !== 's1' || binding.threadId !== 't1')
        throw new Error('private details');
      return { identitySnapshotId: 'identity', workspaceRoot: '/fixture', authorityKey: 'web' };
    },
    admit: vi.fn(),
    id: () => 'v1',
    now: () => 1_000,
    schedule: () => () => {},
  });
  const app = new Hono();
  installVoiceRoutes(app, broker, (request) => ({
    owner: request.headers.get('authorization') ?? 'cookie-owner',
    expiresAt: 4_000_000_000_000,
  }));
  const json = (payload: unknown, extra: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json', ...extra },
    body: JSON.stringify(payload),
  });
  const request = {
    sessionId: 's1',
    threadId: 't1',
    requestId: 'r1',
    offer: { type: 'offer', sdp: 'private-offer' },
  };
  return {
    app,
    broker,
    start,
    stop,
    json,
    request,
    event: (value: VoiceProviderEvent) => event(value),
  };
}

afterEach(() => vi.useRealTimers());

describe('voice HTTP bounded private control plane', () => {
  it('returns unavailable safely and performs zero transport/account work', async () => {
    const f = fixture(false);
    const response = await f.app.request('/api/voice/capabilities');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      available: false,
      blockers: [{ code: 'VOICE_EXECUTION_ISOLATION_UNVERIFIED' }],
    });
    const start = await f.app.request('/api/voice/sessions', f.json(f.request));
    expect(start.status).toBe(503);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('rejects cross-origin, query credentials, extra authority and oversized input before provider work', async () => {
    const f = fixture();
    expect(
      (
        await f.app.request(
          '/api/voice/sessions',
          f.json(f.request, { origin: 'https://evil.test' }),
        )
      ).status,
    ).toBe(403);
    expect((await f.app.request('/api/voice/capabilities?token=private')).status).toBe(403);
    expect(
      (
        await f.app.request(
          '/api/voice/sessions',
          f.json({ ...f.request, permissions: 'operator' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.app.request(
          '/api/voice/sessions',
          f.json({
            ...f.request,
            offer: { type: 'offer', sdp: 'x'.repeat(voiceLimits.maxSdpBytes + 1) },
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await f.app.request(
          '/api/voice/sessions',
          f.json({ padding: 'x'.repeat(voiceLimits.maxBodyBytes) }),
        )
      ).status,
    ).toBe(413);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('creates bounded signaling then exposes only safe snapshots and unsupported interruption', async () => {
    const f = fixture();
    const response = await f.app.request('/api/voice/sessions', f.json(f.request));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      answer: { type: 'answer', sdp: 'private-answer' },
      voice: { id: 'v1', generation: 1 },
    });
    const snapshot = await f.app.request('/api/voice/sessions/v1', {
      headers: { authorization: 'Bearer test' },
    });
    expect(await snapshot.text()).not.toContain('private');
    const interrupt = await f.app.request(
      '/api/voice/sessions/v1/interrupt',
      f.json({ generation: 1, requestId: 'i1' }),
    );
    expect(interrupt.status).toBe(409);
    expect(await interrupt.json()).toMatchObject({
      error: { code: 'VOICE_INTERRUPTION_UNSUPPORTED' },
    });
    const foreign = await f.app.request('/api/voice/sessions/v1', {
      headers: { authorization: 'Bearer other' },
    });
    expect(foreign.status).toBe(403);
    const stop = await f.app.request(
      '/api/voice/sessions/v1/stop',
      f.json({ generation: 1, reason: 'hangup' }),
    );
    expect(await stop.json()).toMatchObject({ phase: 'closed' });
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it('resyncs an ephemeral SSE gap to the correct generation without negotiation data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const f = fixture();
    await f.app.request('/api/voice/sessions', f.json(f.request));
    for (let i = 0; i < 300; i++)
      f.event({
        type: 'transcript',
        itemId: `item-${i}`,
        role: 'user',
        text: 'hello',
        final: true,
      });
    const response = await f.app.request('/api/voice/sessions/v1/events?after=0', {
      headers: { authorization: 'Bearer test' },
    });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    const frame = new TextDecoder().decode(first?.value);
    expect(frame).toContain('event: voice');
    expect(frame).toContain('"type":"voice.resync"');
    expect(frame).toContain('"generation":1');
    expect(frame).not.toContain('private');
    await reader?.cancel();
    expect(vi.getTimerCount()).toBe(0);
    await f.broker.shutdown();
  });
  it('handles malformed bodies, origin and control errors before side effects', async () => {
    const f = fixture();
    for (const origin of ['null', '', 'not-url', 'http://localhost/']) {
      expect(
        (await f.app.request('/api/voice/sessions', f.json(f.request, { origin }))).status,
      ).toBe(403);
    }
    for (const contentType of ['text/plain', 'notapplication/json', 'application/json-extra']) {
      expect(
        (
          await f.app.request(
            '/api/voice/sessions',
            f.json(f.request, { 'content-type': contentType }),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await f.app.request('/api/voice/sessions', {
          method: 'POST',
          headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
          body: '{invalid',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.app.request('/api/voice/sessions', {
          method: 'POST',
          headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.app.request('/api/voice/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(f.request),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.app.request(
          '/api/voice/sessions',
          f.json(f.request, { 'sec-fetch-site': 'cross-site' }),
        )
      ).status,
    ).toBe(403);
    expect((await f.app.request('/api/voice/sessions/missing')).status).toBe(404);
    expect((await f.app.request('/api/voice/sessions/missing/events')).status).toBe(404);
    await f.app.request('/api/voice/sessions', f.json(f.request));
    const heartbeat = await f.app.request(
      '/api/voice/sessions/v1/heartbeat',
      f.json({
        generation: 1,
        observation: { peerState: 'connected', muted: false, playback: 'unknown' },
      }),
    );
    expect(await heartbeat.json()).toMatchObject({ phase: 'active' });
    for (const operation of ['heartbeat', 'stop', 'interrupt']) {
      expect(
        (await f.app.request(`/api/voice/sessions/v1/${operation}`, f.json({ generation: -1 })))
          .status,
      ).toBe(400);
    }
    expect(
      (
        await f.app.request('/api/voice/sessions/v1/events?after=NaN', {
          headers: { authorization: 'Bearer test' },
        })
      ).status,
    ).toBe(400);
    await f.broker.shutdown();
  });
  it('closes terminal streams and abort/expired/backpressured subscriptions without retaining timers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const f = fixture();
    await f.app.request('/api/voice/sessions', f.json(f.request));
    const controller = new AbortController();
    const response = await f.app.request('/api/voice/sessions/v1/events', {
      headers: { authorization: 'Bearer test' },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    await reader?.cancel();
    expect(vi.getTimerCount()).toBe(0);
    const pressured = await f.app.request('/api/voice/sessions/v1/events', {
      headers: { authorization: 'Bearer test' },
    });
    for (let index = 0; index < 300; index++)
      f.event({
        type: 'transcript',
        itemId: `p${index}`,
        role: 'user',
        text: 'bounded',
        final: true,
      });
    expect(vi.getTimerCount()).toBe(0);
    await pressured.body?.cancel();
    const final = await f.app.request('/api/voice/sessions/v1/events', {
      headers: { authorization: 'Bearer test' },
    });
    await f.broker.stop('Bearer test', 'v1', 1);
    expect(await final.text()).toContain('voice.state');
    expect(vi.getTimerCount()).toBe(0);
    await f.broker.shutdown();
  });
  it('never forwards raw authority exceptions', async () => {
    const f = fixture();
    const response = await f.app.request(
      '/api/voice/sessions',
      f.json({ ...f.request, threadId: 'foreign' }),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private details');
  });
});
