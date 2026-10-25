import { describe, expect, it, vi } from 'vitest';
import { NativeVoiceTransport } from '../src/voice/native-transport.js';
import type { NativeVoiceWire } from '../src/voice/native-wire.js';

function fixture(expected: 'offline-memory-v1' | 'subscription-webrtc-v3', actual = expected) {
  let receive: (frame: unknown) => void = () => {};
  const sent: Record<string, unknown>[] = [];
  const close = vi.fn(async () => {});
  const wire: NativeVoiceWire = {
    subscribe: (listener) => {
      receive = listener;
      return () => {};
    },
    close,
    send: (frame) => {
      sent.push(frame);
      if (frame.type === 'hello')
        receive({
          v: 1,
          type: 'hello',
          commandId: frame.commandId,
          profile: actual,
          interruption: 'unsupported',
        });
      if (frame.type === 'close') receive({ v: 1, type: 'closed', commandId: frame.commandId });
    },
  };
  const transport = new NativeVoiceTransport(wire, expected);
  const events: unknown[] = [];
  const start = () =>
    transport.start('synthetic-offer', (event) => events.push(event), new AbortController().signal);
  const event = (type: string, values = {}) => receive({ v: 1, type, ...values });
  return { transport, start, sent, close, events, event };
}

describe('host-chosen native voice profiles', () => {
  it.each([
    ['offline-memory-v1', 'subscription-webrtc-v3'],
    ['subscription-webrtc-v3', 'offline-memory-v1'],
  ] as const)('never accepts %s as %s', async (expected, actual) => {
    const f = fixture(expected, actual);
    await expect(f.start()).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    expect(f.sent.map((frame) => frame.type)).toEqual(['hello']);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it.each([
    'VOICE_CODEX_LOGIN_REQUIRED',
    'VOICE_SUBSCRIPTION_REQUIRED',
    'VOICE_ACCESS_DENIED',
    'VOICE_QUOTA_EXCEEDED',
    'VOICE_RATE_LIMITED',
    'VOICE_AUTHORITY_VIOLATION',
    'VOICE_PROVIDER_DISCONNECTED',
    'VOICE_NEGOTIATION_TIMEOUT',
    'VOICE_CLEANUP_FAILED',
  ])('propagates only sanitized live failure %s', async (code) => {
    const f = fixture('subscription-webrtc-v3');
    const start = f.start();
    await Promise.resolve();
    f.event('error', { commandId: 2, code });
    await expect(start).rejects.toMatchObject({ code });
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('offline rejects the live error extension and both reject raw error messages', async () => {
    const offline = fixture('offline-memory-v1');
    const start = offline.start();
    await Promise.resolve();
    offline.event('error', { commandId: 2, code: 'VOICE_CODEX_LOGIN_REQUIRED' });
    await expect(start).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    const live = fixture('subscription-webrtc-v3');
    const started = live.start();
    await Promise.resolve();
    live.event('error', {
      commandId: 2,
      code: 'VOICE_PROVIDER_ERROR',
      message: 'private-must-not-escape',
    });
    await expect(started).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    expect(JSON.stringify(live.events)).not.toContain('private-must-not-escape');
  });
  it('normalizes live transcript status, gates readiness, never turns speech into handoffs and fences late close', async () => {
    const f = fixture('subscription-webrtc-v3');
    const start = f.start();
    await Promise.resolve();
    f.event('answer', { commandId: 2, sdp: 'answer' });
    f.event('control_ready', { commandId: 2 });
    f.event('transcript', {
      itemId: 'u',
      role: 'user',
      text: 'do not dispatch',
      status: 'partial',
    });
    expect(await start).toBe('answer');
    expect(f.events).toEqual([]);
    f.transport.acceptAnswer();
    f.event('transcript', { itemId: 'a', role: 'assistant', text: 'spoken', status: 'final' });
    expect(f.events).toEqual([
      { type: 'transcript', itemId: 'u', role: 'user', text: 'do not dispatch', final: false },
      { type: 'transcript', itemId: 'a', role: 'assistant', text: 'spoken', final: true },
    ]);
    await f.transport.stop();
    f.event('transcript', { itemId: 'late', role: 'user', text: 'ignored', status: 'final' });
    expect(f.events).toHaveLength(2);
  });
  it.each([
    { role: 'tool', status: 'final' },
    { role: 'user', status: true },
    { role: 'user', status: 'final', text: 'x'.repeat(16385) },
    { role: 'user', status: 'final', final: true },
  ])('rejects malformed live transcript %j', async (values) => {
    const f = fixture('subscription-webrtc-v3');
    const start = f.start();
    await Promise.resolve();
    f.event('transcript', { itemId: 'u', text: 'text', ...values });
    await expect(start).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
  });
  it('offline rejects all transcripts even after control readiness', async () => {
    const f = fixture('offline-memory-v1');
    const start = f.start();
    await Promise.resolve();
    f.event('answer', { commandId: 2, sdp: 'answer' });
    expect(await start).toBe('answer');
    f.transport.acceptAnswer();
    f.event('control_ready', { commandId: 2 });
    f.event('transcript', { itemId: 'u', role: 'user', text: 'text', status: 'final' });
    expect(f.events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'VOICE_PROTOCOL_ERROR' },
    });
    await f.transport.stop();
  });
});
