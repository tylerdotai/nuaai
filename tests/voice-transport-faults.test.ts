import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceError, type VoiceProviderEvent } from '../src/voice/broker.js';
import { CodexVoiceTransport, type VoiceRpcWire } from '../src/voice/codex-transport.js';

function fixture(
  options: {
    auth?: unknown;
    thread?: unknown;
    fault?: string;
    version?: string;
    holdStart?: boolean;
    holdInit?: boolean;
    holdAppend?: boolean;
  } = {},
) {
  let receive: (message: unknown) => void = () => {};
  let failed: (error: VoiceError) => void = () => {};
  const sent: Record<string, unknown>[] = [];
  const wire: VoiceRpcWire = {
    send: (value) => {
      const message = value as Record<string, unknown>;
      sent.push(message);
      if (options.fault === 'throw-send') throw new Error('private wire error');
      if (!message.id || !message.method) return;
      if (options.fault?.startsWith('rpc-') && message.method === 'initialize') {
        receive({
          id: message.id,
          error: {
            code:
              options.fault === 'rpc-method'
                ? -32601
                : options.fault === 'rpc-params'
                  ? -32602
                  : 999,
            message: 'private RPC message',
          },
        });
        return;
      }
      if (options.fault === 'missing-result' && message.method === 'initialize') {
        receive({ id: message.id });
        return;
      }
      if (
        (message.method === 'initialize' && options.holdInit) ||
        (message.method === 'thread/realtime/appendSpeech' && options.holdAppend)
      )
        return;
      let result: unknown = {};
      if (message.method === 'account/read')
        result = { account: options.auth === undefined ? { type: 'chatgpt' } : options.auth };
      if (message.method === 'thread/start')
        result = { thread: options.thread === undefined ? { id: 'backing' } : options.thread };
      if (message.method === 'thread/realtime/start' && !options.holdStart) {
        receive({ method: 'thread/realtime/sdp', params: { threadId: 'backing', sdp: 'answer' } });
        receive({
          method: 'thread/realtime/started',
          params: { threadId: 'backing', version: options.version ?? 'v3' },
        });
      }
      receive({ id: message.id, result });
    },
    subscribe: (listener, onFailure) => {
      receive = listener;
      failed = onFailure;
      return () => {};
    },
    close: vi.fn(async () => {}),
  };
  const events: VoiceProviderEvent[] = [];
  const controller = new AbortController();
  const transport = new CodexVoiceTransport(wire);
  return {
    transport,
    wire,
    sent,
    events,
    controller,
    start: () => transport.start('offer', (event) => events.push(event), controller.signal),
    receive: (message: unknown) => receive(message),
    fail: (error: VoiceError) => failed(error),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => vi.useRealTimers());

describe('voice JSON-RPC fault boundaries', () => {
  it.each([
    [{ fault: 'rpc-method' }, 'VOICE_UNSUPPORTED_VERSION'],
    [{ fault: 'rpc-params' }, 'VOICE_UNSUPPORTED_VERSION'],
    [{ fault: 'rpc-unknown' }, 'VOICE_PROVIDER_ERROR'],
    [{ fault: 'throw-send' }, 'VOICE_PROVIDER_DISCONNECTED'],
    [{ fault: 'missing-result' }, 'VOICE_PROTOCOL_ERROR'],
    [{ auth: null }, 'VOICE_CODEX_LOGIN_REQUIRED'],
    [{ thread: null }, 'VOICE_PROTOCOL_ERROR'],
    [{ thread: { id: '' } }, 'VOICE_PROTOCOL_ERROR'],
    [{ version: 'v2' }, 'VOICE_UNSUPPORTED_VERSION'],
  ] as const)('rejects %j safely with %s', async (options, code) => {
    const f = fixture(options);
    await expect(f.start()).rejects.toMatchObject({ code });
    expect(f.wire.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds missing RPC and missing startup notifications separately and cleans up', async () => {
    const init = fixture({ holdInit: true });
    const initResult = expect(init.start()).rejects.toMatchObject({
      code: 'VOICE_NEGOTIATION_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await initResult;
    const startup = fixture({ holdStart: true });
    const startupResult = expect(startup.start()).rejects.toMatchObject({
      code: 'VOICE_NEGOTIATION_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await startupResult;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('handles abort before and during startup without creating extra provider work', async () => {
    const prior = fixture();
    prior.controller.abort();
    await expect(prior.start()).rejects.toMatchObject({ code: 'VOICE_NEGOTIATION_EXPIRED' });
    expect(prior.sent).toHaveLength(0);
    const active = fixture({ holdInit: true });
    const pending = active.start();
    const checked = expect(pending).rejects.toMatchObject({ code: 'VOICE_NEGOTIATION_EXPIRED' });
    active.controller.abort();
    await checked;
    expect(active.wire.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('normalizes canonical transcripts only and rejects backing execution independently of approvals', async () => {
    const f = fixture();
    await f.start();
    f.receive({
      method: 'thread/realtime/item/completed',
      params: {
        threadId: 'backing',
        item: { type: 'transcriptSegment', id: 't1', role: 'assistant', text: 'hello' },
      },
    });
    expect(f.events).toEqual([
      { type: 'transcript', itemId: 't1', role: 'assistant', text: 'hello', final: true },
    ]);
    for (const method of ['turn/started', 'item/started', 'hook/started'])
      f.receive({ method, params: { threadId: 'backing' } });
    expect(f.events.filter((event) => event.type === 'execution')).toHaveLength(3);
    for (const message of [
      null,
      {},
      { method: 'thread/realtime/sdp', params: { threadId: 'backing', sdp: '' } },
      {
        method: 'thread/realtime/itemAdded',
        params: { threadId: 'backing', item: { type: 'handoff_request', handoff_id: '' } },
      },
      {
        method: 'thread/realtime/item/completed',
        params: {
          threadId: 'backing',
          item: { type: 'transcriptSegment', id: 'bad', role: 'tool', text: 'not authority' },
        },
      },
      {
        method: 'thread/realtime/error',
        params: { threadId: 'backing', message: 'private-error' },
      },
      { method: 'thread/realtime/closed', params: { threadId: 'backing' } },
      { method: 'thread/realtime/sdp', params: {} },
    ])
      f.receive(message);
    expect(f.events.filter((event) => event.type === 'error')).toHaveLength(8);
    expect(JSON.stringify(f.events)).not.toContain('private-error');
    // Duplicate responses and harmless unknown notification kinds are inert.
    const count = f.events.length;
    f.receive({ id: 999, result: {} });
    f.receive({ method: 'unknown' });
    f.receive({ method: 'unknown', params: {} });
    f.receive({
      method: 'thread/realtime/item/completed',
      params: { threadId: 'backing', item: { type: 'other' } },
    });
    f.receive({ method: 'thread/realtime/itemAdded', params: { threadId: 'backing', item: {} } });
    expect(f.events).toHaveLength(count);
    await f.transport.stop();
  });
  it('bounds outstanding delivery RPCs and rejects pending calls on disconnect', async () => {
    const f = fixture({ holdAppend: true });
    await f.start();
    await expect(f.transport.deliver('')).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    const deliveries = Array.from({ length: 16 }, () => f.transport.deliver('verified'));
    const all = Promise.allSettled(deliveries);
    await expect(f.transport.deliver('overflow')).rejects.toMatchObject({
      code: 'VOICE_RATE_LIMITED',
    });
    f.fail(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
    expect((await all).every((result) => result.status === 'rejected')).toBe(true);
    await f.transport.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
