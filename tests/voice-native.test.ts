import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceBroker, VoiceError, type VoiceProviderEvent } from '../src/voice/broker.js';
import { NativeVoiceTransport } from '../src/voice/native-transport.js';
import type { NativeVoiceWire } from '../src/voice/native-wire.js';
import { voiceLimits } from '../src/voice/types.js';

function fixture() {
  let receive: (value: unknown) => void = () => {};
  let failed: (error: VoiceError) => void = () => {};
  const sent: Record<string, unknown>[] = [];
  const wire: NativeVoiceWire = {
    send: (value) => {
      sent.push(value);
    },
    subscribe: (message, error) => {
      receive = message;
      failed = error;
      return () => {};
    },
    close: vi.fn(async () => {}),
  };
  const events: VoiceProviderEvent[] = [];
  const transport = new NativeVoiceTransport(wire);
  const event = (type: string, values: Record<string, unknown> = {}) =>
    receive({ v: 1, type, ...values });
  const start = () =>
    transport.start('offer', (value) => events.push(value), new AbortController().signal);
  const hello = () =>
    event('hello', { commandId: 1, profile: 'offline-memory-v1', interruption: 'unsupported' });
  const answer = () => event('answer', { commandId: 2, sdp: 'answer' });
  const ready = () => event('control_ready', { commandId: 2 });
  const stop = async () => {
    const stopping = transport.stop();
    event('closed', { commandId: sent.at(-1)?.commandId });
    await stopping;
  };
  return {
    transport,
    wire,
    sent,
    events,
    event,
    failed: (error: VoiceError) => failed(error),
    start,
    hello,
    answer,
    ready,
    stop,
  };
}
async function running() {
  const f = fixture();
  const start = f.start();
  f.hello();
  await Promise.resolve();
  f.answer();
  expect(await start).toBe('answer');
  f.transport.acceptAnswer();
  f.ready();
  return f;
}
afterEach(() => vi.useRealTimers());

describe('private native voice transport', () => {
  it('returns answer before control_ready, and sends no start before verified hello', async () => {
    const f = fixture();
    const start = f.start();
    expect(f.sent).toEqual([{ v: 1, type: 'hello', commandId: 1 }]);
    f.hello();
    await Promise.resolve();
    expect(f.sent[1]).toEqual({ v: 1, type: 'start', commandId: 2, offer: 'offer' });
    f.answer();
    expect(await start).toBe('answer');
    expect(f.events).toEqual([]);
    await expect(
      f.transport.deliver('text', { handoffId: 'a', deliveryId: 'd' }),
    ).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    f.ready();
    const stopping = f.transport.stop();
    expect(f.transport.stop()).toBe(stopping);
    f.event('closed', { commandId: 3 });
    await stopping;
    expect(f.sent.filter((frame) => frame.type === 'close')).toHaveLength(1);
    expect(f.wire.close).toHaveBeenCalledOnce();
  });
  it('preserves reverse completion IDs and never resends unknown writes', async () => {
    const f = await running();
    f.event('handoff', { handoffId: 'a', text: 'A' });
    f.event('handoff', { handoffId: 'b', text: 'B' });
    expect(f.events).toEqual([
      { type: 'handoff', handoffId: 'a', text: 'A' },
      { type: 'handoff', handoffId: 'b', text: 'B' },
    ]);
    const b = f.transport.deliver('result B', { handoffId: 'b', deliveryId: 'db' });
    const a = f.transport.deliver('result A', { handoffId: 'a', deliveryId: 'da' });
    f.event('delivery', { commandId: 4, handoffId: 'a', deliveryId: 'da', status: 'accepted' });
    f.event('delivery', { commandId: 3, handoffId: 'b', deliveryId: 'db', status: 'unknown' });
    await a;
    await expect(b).rejects.toMatchObject({ code: 'VOICE_DELIVERY_UNKNOWN' });
    await expect(
      f.transport.deliver('result B', { handoffId: 'b', deliveryId: 'new-id' }),
    ).rejects.toMatchObject({ code: 'VOICE_REQUEST_CONFLICT' });
    expect(f.sent.filter((value) => value.type === 'append')).toEqual([
      { v: 1, type: 'append', commandId: 3, handoffId: 'b', deliveryId: 'db', text: 'result B' },
      { v: 1, type: 'append', commandId: 4, handoffId: 'a', deliveryId: 'da', text: 'result A' },
    ]);
    await expect(f.transport.interrupt()).rejects.toMatchObject({
      code: 'VOICE_INTERRUPTION_UNSUPPORTED',
    });
    await f.stop();
  });
  it.each([
    ['control_ready', { commandId: 2 }],
    ['answer', { commandId: 2, sdp: 'answer', url: 'forbidden' }],
    ['answer', { commandId: 99, sdp: 'answer' }],
    ['answer', { commandId: 2, sdp: '\ud800' }],
    ['answer', { commandId: 2, sdp: 'x'.repeat(voiceLimits.maxSdpBytes + 1) }],
    ['handoff', { handoffId: 'a', text: 'early' }],
    ['error', { code: 'raw-private-message' }],
    ['hello', { commandId: 1, profile: 'live', interruption: 'unsupported' }],
  ])('fails closed on invalid startup %s', async (type, values) => {
    const f = fixture();
    const start = f.start();
    const rejection = expect(start).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    f.hello();
    await Promise.resolve();
    f.event(type, values);
    await rejection;
    expect(f.wire.close).toHaveBeenCalledOnce();
  });
  it.each(['handoffId', 'deliveryId', 'commandId'])(
    'rejects mismatched %s and does not resolve a different append',
    async (field) => {
      const f = await running();
      f.event('handoff', { handoffId: 'a', text: 'A' });
      const result = f.transport.deliver('result', { handoffId: 'a', deliveryId: 'd' });
      f.event('delivery', {
        commandId: 3,
        handoffId: 'a',
        deliveryId: 'd',
        status: 'accepted',
        [field]: field === 'commandId' ? 99 : 'wrong',
      });
      await expect(result).rejects.toMatchObject({ code: 'VOICE_DELIVERY_UNKNOWN' });
      expect(f.events.at(-1)).toMatchObject({
        type: 'error',
        error: { code: 'VOICE_PROTOCOL_ERROR' },
      });
      await f.transport.stop();
    },
  );
  it('EOF rejects sent results as unknown once, fences late events and closes once', async () => {
    const f = await running();
    f.event('handoff', { handoffId: 'a', text: 'A' });
    const delivery = f.transport.deliver('result', { handoffId: 'a', deliveryId: 'd' });
    const rejected = expect(delivery).rejects.toMatchObject({ code: 'VOICE_DELIVERY_UNKNOWN' });
    f.failed(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
    f.failed(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
    f.event('delivery', { commandId: 3, handoffId: 'a', deliveryId: 'd', status: 'accepted' });
    f.event('handoff', { handoffId: 'b', text: 'late' });
    await rejected;
    await f.transport.stop();
    expect(f.events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(f.events.filter((event) => event.type === 'handoff')).toHaveLength(1);
    expect(f.wire.close).toHaveBeenCalledOnce();
  });
  it('bounds pending appends, IDs and UTF-8 bytes before sending', async () => {
    const f = await running();
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 17; i++) {
      f.event('handoff', { handoffId: `h${i}`, text: 'task' });
      if (i < 16)
        pending.push(f.transport.deliver('result', { handoffId: `h${i}`, deliveryId: `d${i}` }));
    }
    await expect(
      f.transport.deliver('result', { handoffId: 'h16', deliveryId: 'd16' }),
    ).rejects.toMatchObject({ code: 'VOICE_RATE_LIMITED' });
    await expect(
      f.transport.deliver('é'.repeat(voiceLimits.maxTranscriptBytes), {
        handoffId: 'h16',
        deliveryId: 'd16',
      }),
    ).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    await expect(
      f.transport.deliver('result', { handoffId: 'h16', deliveryId: 'x'.repeat(257) }),
    ).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    f.failed(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
    expect(
      (await Promise.allSettled(pending)).every((result) => result.status === 'rejected'),
    ).toBe(true);
    await f.transport.stop();
  });
  it('keeps a separate bounded ready deadline after answering', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const start = f.start();
    f.hello();
    await Promise.resolve();
    f.answer();
    expect(await start).toBe('answer');
    await vi.advanceTimersByTimeAsync(voiceLimits.startTimeoutMs);
    expect(f.events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'VOICE_NEGOTIATION_TIMEOUT' },
    });
    expect(f.wire.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds missing close acknowledgement and cleans the wire', async () => {
    const f = await running();
    vi.useFakeTimers();
    const rejection = expect(f.transport.stop()).rejects.toMatchObject({
      code: 'VOICE_CLEANUP_FAILED',
    });
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    expect(f.wire.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('abort before hello closes without sending any commands', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.transport.start('offer', () => {}, controller.signal)).rejects.toMatchObject({
      code: 'VOICE_NEGOTIATION_EXPIRED',
    });
    expect(f.sent).toEqual([]);
    expect(f.wire.close).toHaveBeenCalledOnce();
  });
  it('holds only control-ready handoffs for explicit host acceptance and fences close', async () => {
    const f = fixture();
    const start = f.start();
    f.hello();
    await Promise.resolve();
    f.answer();
    f.ready();
    f.event('handoff', { handoffId: 'a', text: 'task' });
    expect(await start).toBe('answer');
    expect(f.events).toEqual([]);
    f.transport.acceptAnswer();
    expect(f.events).toEqual([{ type: 'handoff', handoffId: 'a', text: 'task' }]);
    f.transport.acceptAnswer();
    expect(f.events).toHaveLength(1);
    await f.stop();
    f.transport.acceptAnswer();
    expect(f.events).toHaveLength(1);
  });
  it('bounds queued ready handoffs and discards them on failure', async () => {
    const f = fixture();
    const start = f.start();
    f.hello();
    await Promise.resolve();
    f.answer();
    f.ready();
    expect(await start).toBe('answer');
    for (let i = 0; i <= voiceLimits.maxEvents; i++)
      f.event('handoff', { handoffId: 'same', text: 'task' });
    f.transport.acceptAnswer();
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ type: 'error', error: { code: 'VOICE_PROTOCOL_ERROR' } });
    expect(f.wire.close).toHaveBeenCalledOnce();
    await f.transport.stop();
  });
  it('broker accepts valid coalesced answer-ready-handoff in one synchronous read', async () => {
    let receive: (frame: unknown) => void = () => {};
    const wire: NativeVoiceWire = {
      subscribe: (listener) => {
        receive = listener;
        return () => {};
      },
      send: (frame) => {
        if (frame.type === 'hello')
          queueMicrotask(() =>
            receive({
              v: 1,
              type: 'hello',
              commandId: frame.commandId,
              profile: 'offline-memory-v1',
              interruption: 'unsupported',
            }),
          );
        if (frame.type === 'start') {
          receive({ v: 1, type: 'answer', commandId: frame.commandId, sdp: 'answer' });
          receive({ v: 1, type: 'control_ready', commandId: frame.commandId });
          receive({ v: 1, type: 'handoff', handoffId: 'coalesced', text: 'durable task' });
        }
        if (frame.type === 'close') receive({ v: 1, type: 'closed', commandId: frame.commandId });
      },
      close: vi.fn(async () => {}),
    };
    const transport = new NativeVoiceTransport(wire);
    const admit = vi.fn(() => ({ runId: 'durable-run', result: new Promise<string>(() => {}) }));
    const broker = new VoiceBroker({
      provider: {
        availability: () => ({ available: true, taskMode: 'daemon', interruption: 'unsupported' }),
        create: () => transport,
      },
      authorize: () => ({
        identitySnapshotId: 'identity',
        authorityKey: 'owner',
        workspaceRoot: '/fixture',
      }),
      admit,
      schedule: () => () => {},
    });
    try {
      await expect(
        broker.start('owner', {
          sessionId: 's',
          threadId: 't',
          requestId: 'r',
          offer: { type: 'offer', sdp: 'offer' },
        }),
      ).resolves.toMatchObject({ answer: { sdp: 'answer' } });
      expect(admit).toHaveBeenCalledOnce();
    } finally {
      await broker.shutdown();
    }
  });
  it('broker never admits a handoff before control_ready, even after its answer is accepted', async () => {
    const f = fixture();
    const admit = vi.fn();
    const broker = new VoiceBroker({
      provider: {
        availability: () => ({ available: true, taskMode: 'daemon', interruption: 'unsupported' }),
        create: () => f.transport,
      },
      authorize: () => ({
        identitySnapshotId: 'identity',
        authorityKey: 'owner',
        workspaceRoot: '/fixture',
      }),
      admit,
      schedule: () => () => {},
    });
    const start = broker.start('owner', {
      sessionId: 's',
      threadId: 't',
      requestId: 'r',
      offer: { type: 'offer', sdp: 'offer' },
    });
    f.hello();
    await Promise.resolve();
    f.answer();
    const { voice } = await start;
    f.event('handoff', { handoffId: 'early', text: 'must not run' });
    await f.transport.stop();
    expect(admit).not.toHaveBeenCalled();
    expect(broker.get('owner', voice.id).failure?.code).toBe('VOICE_PROTOCOL_ERROR');
    expect(f.wire.close).toHaveBeenCalledOnce();
    await broker.shutdown();
  });
  it('broker rejects early handoff and preserves admitted durable work across hang-up', async () => {
    const f = fixture();
    let finish!: (value: string) => void;
    const result = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const admit = vi.fn(() => ({ runId: 'durable-run', result }));
    const broker = new VoiceBroker({
      provider: {
        availability: () => ({ available: true, taskMode: 'daemon', interruption: 'unsupported' }),
        create: () => f.transport,
      },
      authorize: () => ({
        identitySnapshotId: 'identity',
        authorityKey: 'owner',
        workspaceRoot: '/fixture',
      }),
      admit,
      schedule: () => () => {},
    });
    const start = broker.start('owner', {
      sessionId: 's',
      threadId: 't',
      requestId: 'r',
      offer: { type: 'offer', sdp: 'offer' },
    });
    f.hello();
    await Promise.resolve();
    f.answer();
    const { voice } = await start;
    f.ready();
    f.event('handoff', { handoffId: 'a', text: 'durable task' });
    expect(admit).toHaveBeenCalledOnce();
    expect(() =>
      broker.heartbeat('owner', voice.id, {
        generation: voice.generation + 1,
        observation: { peerState: 'connected', muted: false, playback: 'unknown' },
      }),
    ).toThrow(/VOICE_STALE_GENERATION/);
    const stop = broker.stop('owner', voice.id, voice.generation);
    f.event('closed', { commandId: 3 });
    await stop;
    finish('authoritative durable result');
    await Promise.resolve();
    f.event('handoff', { handoffId: 'late', text: 'stale' });
    expect(admit).toHaveBeenCalledOnce();
    expect(f.sent.filter((message) => message.type === 'append')).toEqual([]);
    expect(f.sent.filter((message) => message.type === 'close')).toEqual([
      { v: 1, type: 'close', commandId: 3 },
    ]);
    expect(f.wire.close).toHaveBeenCalledOnce();
    expect(broker.get('owner', voice.id).phase).toBe('closed');
  });
});
