import { describe, expect, it, vi } from 'vitest';
import { VoiceBroker, type VoiceProviderEvent } from '../src/voice/broker.js';
import { voiceLimits } from '../src/voice/types.js';

function fixture(credentialExpiresAt = Number.POSITIVE_INFINITY) {
  let now = 1_000;
  let receive: (event: VoiceProviderEvent) => void = () => {};
  let result!: (text: string) => void;
  const completed = new Promise<string>((resolve) => {
    result = resolve;
  });
  const deliver = vi.fn(async () => {});
  const interrupt = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const admit = vi.fn(() => ({ runId: 'durable-run', result: completed }));
  const broker = new VoiceBroker({
    provider: {
      availability: () => ({ available: true, taskMode: 'daemon', interruption: 'provider' }),
      create: () => ({
        start: async (_offer, event) => {
          receive = event;
          return 'answer';
        },
        stop,
        deliver,
        interrupt,
      }),
    },
    authorize: () => ({ identitySnapshotId: 'i1', workspaceRoot: '/fixture', authorityKey: 'web' }),
    admit,
    now: () => now,
    id: () => 'v1',
    schedule: () => () => {}, // expiry timer deliberately never runs
  });
  return {
    broker,
    admit,
    deliver,
    interrupt,
    stop,
    result,
    setNow: (value: number) => {
      now = value;
    },
    event: (value: VoiceProviderEvent) => receive(value),
    start: () =>
      broker.start(
        'owner',
        {
          sessionId: 's1',
          threadId: 't1',
          requestId: 'r1',
          offer: { type: 'offer', sdp: 'offer' },
        },
        credentialExpiresAt,
      ),
  };
}

describe('eager voice lease authority when cleanup timer is delayed', () => {
  it.each([
    ['lease exact', 31_000, undefined, 'VOICE_LEASE_EXPIRED'],
    ['lease late', 31_001, undefined, 'VOICE_LEASE_EXPIRED'],
    ['hard deadline', 1_000 + voiceLimits.maxDurationMs, undefined, 'VOICE_DURATION_EXCEEDED'],
    ['credential exact', 2_000, 2_000, 'VOICE_LEASE_EXPIRED'],
  ] as const)('rejects %s handoff before run admission', async (_label, time, credential, code) => {
    const f = fixture(credential);
    await f.start();
    f.setNow(time);
    f.event({ type: 'handoff', handoffId: 'late', text: 'do not admit' });
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.broker.get('owner', 'v1').failure?.code).toBe(code);
    await f.broker.shutdown();
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it('preserves the durable run but refuses delayed result append after expiry', async () => {
    const f = fixture();
    await f.start();
    f.event({ type: 'handoff', handoffId: 'h1', text: 'authorized task' });
    expect(f.admit).toHaveBeenCalledOnce();
    f.setNow(31_000);
    f.result('verified completion belongs to durable conversation');
    await Promise.resolve();
    await Promise.resolve();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.broker.get('owner', 'v1').failure?.code).toBe('VOICE_LEASE_EXPIRED');
    await f.broker.shutdown();
  });
  it('cannot renew or interrupt an expired lease; late transcripts do not publish', async () => {
    const f = fixture();
    const { voice } = await f.start();
    const listener = vi.fn();
    f.broker.subscribe('owner', 'v1', listener);
    f.setNow(voice.leaseExpiresAt);
    await expect(f.broker.interrupt('owner', 'v1', 1)).rejects.toMatchObject({
      code: 'VOICE_LEASE_EXPIRED',
    });
    expect(f.interrupt).not.toHaveBeenCalled();
    f.event({
      type: 'transcript',
      itemId: 'late',
      role: 'user',
      text: 'not admitted',
      final: true,
    });
    const heartbeat = f.broker.heartbeat('owner', 'v1', {
      generation: 1,
      observation: { peerState: 'connected', muted: false, playback: 'unknown' },
    });
    expect(['stopping', 'failed']).toContain(heartbeat.phase);
    expect(heartbeat.leaseExpiresAt).toBe(voice.leaseExpiresAt);
    expect(listener.mock.calls.some(([event]) => event.type === 'voice.transcript')).toBe(false);
    await f.broker.shutdown();
  });
  it('rejects heartbeat exactly at deadline even without any preceding event', async () => {
    const f = fixture();
    const { voice } = await f.start();
    f.setNow(voice.leaseExpiresAt);
    expect(() =>
      f.broker.heartbeat('owner', 'v1', {
        generation: 1,
        observation: { peerState: 'connected', muted: false, playback: 'playing' },
      }),
    ).toThrow('VOICE_LEASE_EXPIRED');
    expect(f.broker.get('owner', 'v1').leaseExpiresAt).toBe(voice.leaseExpiresAt);
    await f.broker.shutdown();
  });
});
