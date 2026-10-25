import { describe, expect, it, vi } from 'vitest';
import { voiceLimits } from '../src/voice/types.js';
import { createVoiceApi, voiceBrowserSupport } from '../src/web/voice-client.js';

describe('voice browser daemon boundary', () => {
  it.each([
    ['VOICE_CODEX_LOGIN_REQUIRED', 'existing Codex/ChatGPT sign-in'],
    ['VOICE_SUBSCRIPTION_REQUIRED', 'eligible ChatGPT subscription'],
    ['VOICE_ACCESS_DENIED', 'does not have access'],
    ['VOICE_QUOTA_EXCEEDED', 'voice quota'],
    ['VOICE_RATE_LIMITED', 'start again explicitly'],
  ])(
    'explains %s without exposing upstream details or suggesting an API-key fallback',
    async (code, guidance) => {
      const api = createVoiceApi(
        '/',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                error: {
                  code,
                  message: 'PRIVATE_UPSTREAM_DETAILS',
                  retryable: false,
                  stage: 'start',
                },
              }),
              { status: 503 },
            ),
        ),
      );
      await expect(api.capabilities()).rejects.toThrow(guidance);
      await expect(api.capabilities()).rejects.not.toThrow('PRIVATE_UPSTREAM_DETAILS');
    },
  );
  it('accepts named lease events and closes once on a malformed or lost stream without reconnecting', () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const source = {
      addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) =>
        listeners.set(type, handler),
      ),
      close: vi.fn(),
      onerror: null,
    };
    const factory = vi.fn(() => source as unknown as EventSource);
    const api = createVoiceApi('/nuaai/', vi.fn(), factory);
    const event = vi.fn();
    const failed = vi.fn();
    const unsubscribe = api.subscribe('lease/a', event, failed);
    expect(factory).toHaveBeenCalledWith('/nuaai/api/voice/sessions/lease%2Fa/events');
    listeners.get('voice')?.(
      new MessageEvent('voice', {
        data: JSON.stringify({ v: 1, seq: 1, revision: 1, payload: { phase: 'active' } }),
      }),
    );
    expect(event).toHaveBeenCalledTimes(1);
    listeners.get('voice')?.(new MessageEvent('voice', { data: 'not-json' }));
    listeners.get('voice')?.(new MessageEvent('voice', { data: 'not-json' }));
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(source.onerror).toBeNull();
  });
  it('keeps authentication same-origin and mount-relative, never puts negotiation data in URLs', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return new Response(JSON.stringify({ voice: { id: 'lease/a' } }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const api = createVoiceApi('/nuaai/', fetcher);
    await api.start({
      sessionId: 's',
      threadId: 't',
      requestId: 'r',
      offer: { type: 'offer', sdp: 'fixture-only' },
    });
    await api.stop('lease/a', { generation: 2, reason: 'navigation' });
    expect(calls.map((call) => call.path)).toEqual([
      '/nuaai/api/voice/sessions',
      '/nuaai/api/voice/sessions/lease%2Fa/stop',
    ]);
    expect(calls[0].init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      offer: { sdp: 'fixture-only' },
    });
    expect(calls[0].path).not.toContain('fixture-only');
  });

  it('preserves structured auth and unavailable failures but hides unknown response bodies', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'Session expired — pair this device again.',
            code: 'AUTH_EXPIRED',
          }),
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'VOICE_EXECUTION_ISOLATION_UNVERIFIED',
              message: 'Voice is unavailable.',
              retryable: false,
              stage: 'preflight',
            },
          }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(new Response('fixture-private-response', { status: 500 }));
    const api = createVoiceApi('/', fetcher);
    await expect(api.capabilities()).rejects.toThrow('Session expired — pair this device again.');
    await expect(api.capabilities()).rejects.toThrow('Voice is unavailable.');
    await expect(api.capabilities()).rejects.not.toThrow('fixture-private-response');
  });

  it('requires a secure microphone-capable browser without activating a device', () => {
    expect(voiceBrowserSupport({ secure: false, microphone: true, peer: true })).toContain('HTTPS');
    expect(voiceBrowserSupport({ secure: true, microphone: false, peer: true })).toContain(
      'microphone',
    );
    expect(voiceBrowserSupport({ secure: true, microphone: true, peer: false })).toContain(
      'WebRTC',
    );
    expect(voiceBrowserSupport({ secure: true, microphone: true, peer: true })).toBeNull();
    expect(voiceLimits.startTimeoutMs).toBeGreaterThan(0);
  });
});
