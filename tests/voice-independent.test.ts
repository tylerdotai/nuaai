// Independent synthetic protocol/fault acceptance. No provider, microphone or audible-speech proof.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VoiceBroker,
  VoiceError,
  type VoiceProviderEvent,
  type VoiceTransport,
} from '../src/voice/broker.js';
import { unsupportedCodexVoiceProvider } from '../src/voice/codex-transport.js';
import { type VoiceStartRequest, voiceLimits } from '../src/voice/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const brokers: VoiceBroker[] = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.shutdown()));
});

function fixture() {
  let now = 1_000;
  let sequence = 0;
  let authority = {
    identitySnapshotId: 'identity-1',
    workspaceRoot: '/fixture',
    authorityKey: 'read',
  };
  const timers = new Map<() => void, number>();
  const transports: Array<{
    transport: VoiceTransport;
    receive?: (event: VoiceProviderEvent) => void;
    signal?: AbortSignal;
  }> = [];
  const admitted: Array<{
    text: string;
    key: string;
    authority: typeof authority;
    result: ReturnType<typeof deferred<string>>;
  }> = [];
  const create = vi.fn(() => {
    const entry: (typeof transports)[number] = {
      transport: {
        start: vi.fn(async (_offer, receive, signal) => {
          entry.receive = receive;
          entry.signal = signal;
          return 'synthetic-answer';
        }),
        stop: vi.fn(async () => {}),
        deliver: vi.fn(async () => {}),
        interrupt: vi.fn(async () => {}),
      },
    };
    transports.push(entry);
    return entry.transport;
  });
  const broker = new VoiceBroker({
    provider: {
      availability: () => ({ available: true, taskMode: 'daemon', interruption: 'provider' }),
      create,
    },
    authorize: (_owner, binding) => {
      if (binding.sessionId !== 'session' || binding.threadId !== 'thread')
        throw new VoiceError('VOICE_FORBIDDEN', 403);
      return { ...authority };
    },
    admit: (_binding, text, key, captured) => {
      const result = deferred<string>();
      admitted.push({ text, key, authority: { ...captured }, result });
      return { runId: `run-${admitted.length}`, result: result.promise };
    },
    now: () => now,
    id: () => `voice-${++sequence}`,
    schedule: (delay, callback) => {
      timers.set(callback, now + delay);
      return () => timers.delete(callback);
    },
  });
  brokers.push(broker);
  const request: VoiceStartRequest = {
    sessionId: 'session',
    threadId: 'thread',
    requestId: 'request-1',
    offer: { type: 'offer', sdp: 'synthetic-offer' },
  };
  return {
    broker,
    request,
    transports,
    admitted,
    create,
    timers,
    changeAuthority: () => {
      authority = { ...authority, authorityKey: 'revoked' };
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe('independent synthetic voice acceptance', () => {
  it('fails closed before transport creation, account RPC or task admission when isolation is unverified', async () => {
    const create = vi.fn(unsupportedCodexVoiceProvider.create);
    const authorize = vi.fn();
    const admit = vi.fn();
    const broker = new VoiceBroker({
      provider: { ...unsupportedCodexVoiceProvider, create },
      authorize,
      admit,
    });
    brokers.push(broker);
    expect(broker.capabilities()).toMatchObject({
      available: false,
      billing: 'subscription-only',
      taskMode: 'disabled',
      blockers: [{ code: 'VOICE_EXECUTION_ISOLATION_UNVERIFIED', stage: 'preflight' }],
    });
    await expect(
      broker.start('owner', {
        sessionId: 'session',
        threadId: 'thread',
        requestId: 'request',
        offer: { type: 'offer', sdp: 'synthetic-offer' },
      }),
    ).rejects.toMatchObject({ code: 'VOICE_EXECUTION_ISOLATION_UNVERIFIED' });
    expect(create).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('replays one negotiation without a second provider and rejects changed request payloads', async () => {
    const f = fixture();
    const [first, replay] = await Promise.all([
      f.broker.start('owner', f.request),
      f.broker.start('owner', f.request),
    ]);
    expect(replay).toEqual(first);
    expect(f.create).toHaveBeenCalledTimes(1);
    await expect(
      f.broker.start('owner', {
        ...f.request,
        offer: { type: 'offer', sdp: 'different-offer' },
      }),
    ).rejects.toMatchObject({ code: 'VOICE_REQUEST_CONFLICT' });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('fences owner, generation and authority without invoking executable controls for rejected callers', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    await expect(f.broker.stop('intruder', voice.id, voice.generation)).rejects.toMatchObject({
      code: 'VOICE_FORBIDDEN',
    });
    await expect(f.broker.stop('owner', voice.id, voice.generation + 1)).rejects.toMatchObject({
      code: 'VOICE_STALE_GENERATION',
    });
    expect(() => f.broker.events('intruder', voice.id, 0)).toThrow('VOICE_FORBIDDEN');
    expect(() => f.broker.subscribe('intruder', voice.id, () => {})).toThrow('VOICE_FORBIDDEN');
    expect(f.transports[0].transport.stop).not.toHaveBeenCalled();
    f.changeAuthority();
    f.transports[0].receive?.({ type: 'handoff', handoffId: 'after-revoke', text: 'Write a file' });
    await f.broker.stop('owner', voice.id, voice.generation);
    expect(f.admitted).toEqual([]);
    expect(f.broker.get('owner', voice.id)).toMatchObject({
      phase: 'failed',
      failure: { code: 'VOICE_BINDING_CONFLICT' },
    });
    expect(f.transports[0].transport.stop).toHaveBeenCalledTimes(1);
  });

  it('claims each handoff exactly once and fails a changed duplicate before a second task effect', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    const event = { type: 'handoff' as const, handoffId: 'call-1', text: 'Read fixture.txt' };
    f.transports[0].receive?.(event);
    f.transports[0].receive?.(event);
    expect(f.admitted).toHaveLength(1);
    expect(f.admitted[0]).toMatchObject({ text: event.text, authority: { authorityKey: 'read' } });
    expect(f.admitted[0].key).toContain(`voice:${voice.id}:${voice.generation}:`);
    expect(
      f.broker.events('owner', voice.id, 0).filter((e) => e.type === 'voice.run.linked'),
    ).toHaveLength(1);
    f.transports[0].receive?.({ ...event, text: 'Different task' });
    await f.broker.stop('owner', voice.id, voice.generation);
    expect(f.admitted).toHaveLength(1);
    expect(f.broker.get('owner', voice.id)).toMatchObject({
      phase: 'failed',
      failure: { code: 'VOICE_AUTHORITY_VIOLATION' },
    });
  });

  it('hangup preserves admitted task completion but never delivers its late result to a replacement lease', async () => {
    const f = fixture();
    const first = await f.broker.start('owner', f.request);
    f.transports[0].receive?.({ type: 'handoff', handoffId: 'work', text: 'Read fixture.txt' });
    await f.broker.stop('owner', first.voice.id, first.voice.generation);
    expect(f.transports[0].signal?.aborted).toBe(true);
    const second = await f.broker.start('owner', { ...f.request, requestId: 'request-2' });
    expect(second.voice.generation).toBeGreaterThan(first.voice.generation);
    f.admitted[0].result.resolve('Verified fixture result');
    await f.admitted[0].result.promise;
    expect(f.admitted).toHaveLength(1);
    for (const entry of f.transports) expect(entry.transport.deliver).not.toHaveBeenCalled();
    expect(
      f.broker.events('owner', first.voice.id, 0).some((e) => e.type === 'voice.result.delivery'),
    ).toBe(false);
    expect(
      f.broker.events('owner', second.voice.id, 0).some((e) => e.type === 'voice.result.delivery'),
    ).toBe(false);
    expect(f.broker.get('owner', second.voice.id).phase).toBe('negotiating');
  });

  it('reports delivery acknowledgement separately from browser-reported playback, never as audible proof', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    const acknowledgement = deferred<void>();
    vi.mocked(f.transports[0].transport.deliver).mockReturnValue(acknowledgement.promise);
    f.transports[0].receive?.({ type: 'handoff', handoffId: 'work', text: 'Read fixture.txt' });
    f.admitted[0].result.resolve('Verified result');
    await f.admitted[0].result.promise;
    const deliveries = () =>
      f.broker.events('owner', voice.id, 0).filter((e) => e.type === 'voice.result.delivery');
    expect(deliveries()).toMatchObject([{ payload: { runId: 'run-1', status: 'pending' } }]);
    acknowledgement.resolve();
    await acknowledgement.promise;
    expect(deliveries()).toMatchObject([
      { payload: { status: 'pending' } },
      { payload: { status: 'accepted' } },
    ]);
    expect(f.broker.events('owner', voice.id, 0).some((e) => e.type === 'voice.observation')).toBe(
      false,
    );
    f.broker.heartbeat('owner', voice.id, {
      generation: voice.generation,
      observation: { peerState: 'connected', muted: false, playback: 'blocked' },
    });
    expect(f.broker.events('owner', voice.id, 0).at(-1)).toMatchObject({
      type: 'voice.observation',
      payload: { source: 'browser', playback: 'blocked' },
    });
    expect(deliveries().at(-1)).toMatchObject({ payload: { status: 'accepted' } });
  });

  it('marks replay gaps for resync and retains owner-bound monotonic events without negotiation data', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    for (let index = 0; index < voiceLimits.maxEvents + 2; index++) {
      f.transports[0].receive?.({
        type: 'transcript',
        itemId: `item-${index}`,
        role: 'user',
        text: `phrase ${index}`,
        final: true,
      });
    }
    const gap = f.broker.events('owner', voice.id, 0);
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatchObject({
      type: 'voice.resync',
      voiceId: voice.id,
      generation: voice.generation,
      sessionId: 'session',
      threadId: 'thread',
    });
    const tail = f.broker.events('owner', voice.id, gap[0].seq - 2);
    expect(tail.map((e) => e.seq)).toEqual([gap[0].seq - 1, gap[0].seq]);
    expect(JSON.stringify(gap)).not.toContain('synthetic-offer');
    expect(JSON.stringify(gap)).not.toContain('synthetic-answer');
    expect(f.broker.events('owner', voice.id, gap[0].seq + 1)[0].type).toBe('voice.resync');
  });

  it.each([voiceLimits.leaseMs, voiceLimits.leaseMs + 1])(
    'rejects provider handoff at expired lease boundary +%sms even when cleanup timer is held',
    async (elapsed) => {
      const f = fixture();
      const { voice } = await f.broker.start('owner', f.request);
      f.advance(elapsed); // Deliberately do not fire the scheduled cleanup callback.
      f.transports[0].receive?.({
        type: 'handoff',
        handoffId: 'expired',
        text: 'Write fixture.txt',
      });
      expect(f.admitted).toEqual([]);
      await Promise.resolve()
        .then(() =>
          f.broker.heartbeat('owner', voice.id, {
            generation: voice.generation,
            observation: { peerState: 'connected', muted: false, playback: 'unknown' },
          }),
        )
        .then(
          (snapshot) => {
            expect(['stopping', 'failed']).toContain(snapshot.phase);
            expect(snapshot.leaseExpiresAt).toBe(voice.leaseExpiresAt);
          },
          (error: unknown) => expect(error).toMatchObject({ code: 'VOICE_LEASE_EXPIRED' }),
        );
      await f.broker.stop('owner', voice.id, voice.generation);
      expect(f.broker.get('owner', voice.id)).toMatchObject({
        phase: 'failed',
        failure: { code: 'VOICE_LEASE_EXPIRED' },
      });
    },
  );

  it('does not append a completed durable result after lease expiry even with its cleanup timer held', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    f.transports[0].receive?.({ type: 'handoff', handoffId: 'work', text: 'Read fixture.txt' });
    expect(f.admitted).toHaveLength(1);
    f.advance(voiceLimits.leaseMs);
    f.admitted[0].result.resolve('Completed after lease expired');
    await f.admitted[0].result.promise;
    expect(f.transports[0].transport.deliver).not.toHaveBeenCalled();
    await f.broker.stop('owner', voice.id, voice.generation);
    expect(f.admitted).toHaveLength(1); // The admitted durable work was not cancelled.
    expect(
      f.broker
        .events('owner', voice.id, 0)
        .some(
          (event) => event.type === 'voice.result.delivery' && event.payload.status === 'accepted',
        ),
    ).toBe(false);
  });

  it('treats backing execution as a violation and tears down without admitting daemon work', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    f.transports[0].receive?.({ type: 'execution' });
    await f.broker.stop('owner', voice.id, voice.generation);
    expect(f.admitted).toEqual([]);
    expect(f.transports[0].signal?.aborted).toBe(true);
    expect(f.transports[0].transport.stop).toHaveBeenCalledTimes(1);
    expect(f.broker.get('owner', voice.id)).toMatchObject({
      phase: 'failed',
      failure: { code: 'VOICE_AUTHORITY_VIOLATION' },
    });
    // This proves detection/teardown only, not prevention of an upstream effect.
  });

  it('bounds a provider that never acknowledges stop and reports cleanup failure rather than closed', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    const enteredStop = deferred<void>();
    vi.mocked(f.transports[0].transport.stop).mockImplementation(() => {
      enteredStop.resolve();
      return new Promise<void>(() => {});
    });
    const stopped = f.broker.stop('owner', voice.id, voice.generation);
    await enteredStop.promise;
    expect(f.broker.get('owner', voice.id).phase).toBe('stopping');
    const deadline = [...f.timers].find(([, due]) => due === 5_000);
    if (!deadline) throw new Error('Stop must arm its bounded cleanup deadline');
    deadline[0]();
    expect(await stopped).toMatchObject({
      phase: 'failed',
      failure: { code: 'VOICE_CLEANUP_FAILED', stage: 'stop' },
    });
    expect(f.transports[0].transport.stop).toHaveBeenCalledTimes(1);
    expect(f.transports[0].signal?.aborted).toBe(true);
  });

  it('expires leases with injected time, stops the provider once and removes all timers at shutdown', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    f.advance(voiceLimits.leaseMs);
    await f.broker.sweep();
    expect(f.broker.get('owner', voice.id)).toMatchObject({
      phase: 'failed',
      failure: { code: 'VOICE_LEASE_EXPIRED' },
    });
    expect(f.transports[0].signal?.aborted).toBe(true);
    expect(f.transports[0].transport.stop).toHaveBeenCalledTimes(1);
    await f.broker.shutdown();
    expect(f.timers.size).toBe(0);
    expect(f.transports[0].transport.stop).toHaveBeenCalledTimes(1);
  });
});
