import { describe, expect, it, vi } from 'vitest';
import { VoiceBroker, type VoiceProviderEvent, type VoiceTransport } from '../src/voice/broker.js';
import { voiceLimits, voicePaths } from '../src/voice/types.js';

function fixture() {
  let time = 1_000;
  let listener: (event: VoiceProviderEvent) => void = () => {};
  const stop = vi.fn(async () => {});
  const start = vi.fn(async (_offer: string, receive: typeof listener) => {
    listener = receive;
    return 'answer-canary';
  });
  const transport: VoiceTransport = {
    start,
    stop,
    deliver: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
  };
  let identity = 'identity-1';
  const admit = vi.fn(() => ({ runId: 'run-1', result: Promise.resolve('verified result') }));
  const broker = new VoiceBroker({
    provider: {
      availability: () => ({ available: true, taskMode: 'daemon', interruption: 'provider' }),
      create: () => transport,
    },
    authorize: () => ({
      identitySnapshotId: identity,
      workspaceRoot: '/fixture',
      authorityKey: 'web-operator',
    }),
    admit,
    now: () => time,
    id: () => 'voice-1',
    schedule: () => () => {},
  });
  const request = {
    sessionId: 'session-1',
    threadId: 'thread-1',
    requestId: 'request-1',
    offer: { type: 'offer' as const, sdp: 'offer-canary' },
  };
  return {
    broker,
    request,
    start,
    stop,
    admit,
    transport,
    event: (event: VoiceProviderEvent) => listener(event),
    advance: (ms: number) => {
      time += ms;
    },
    changeIdentity: () => {
      identity = 'identity-2';
    },
  };
}

describe('voice broker authority and lifecycle', () => {
  it('publishes mount-relative encoded paths and bounded subscription contract', () => {
    expect(voicePaths.events('../x')).toBe('api/voice/sessions/..%2Fx/events');
    expect(voiceLimits.maxSdpBytes).toBe(98_304);
  });
  it('fails closed before transport creation when isolation is unavailable', async () => {
    const create = vi.fn();
    const broker = new VoiceBroker({
      provider: {
        availability: () => ({
          available: false,
          taskMode: 'disabled',
          interruption: 'unsupported',
        }),
        create,
      },
      authorize: vi.fn(),
      admit: vi.fn(),
    });
    await expect(broker.start('owner', fixture().request)).rejects.toMatchObject({
      code: 'VOICE_EXECUTION_ISOLATION_UNVERIFIED',
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('deduplicates creation, rejects changed payload and foreign owner; never projects SDP', async () => {
    const f = fixture();
    const a = await f.broker.start('owner', f.request);
    expect(await f.broker.start('owner', f.request)).toEqual(a);
    expect(f.start).toHaveBeenCalledTimes(1);
    await expect(
      f.broker.start('owner', { ...f.request, offer: { type: 'offer', sdp: 'changed' } }),
    ).rejects.toMatchObject({ code: 'VOICE_REQUEST_CONFLICT' });
    expect(() => f.broker.get('foreign', a.voice.id)).toThrow(/VOICE_FORBIDDEN/);
    expect(JSON.stringify(f.broker.events('owner', a.voice.id, 0))).not.toContain('canary');
    expect(JSON.stringify(f.broker.get('owner', a.voice.id))).not.toContain('canary');
  });
  it('renews authenticated lease, rejects stale generations and expires silent clients', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    expect(() =>
      f.broker.heartbeat('owner', voice.id, {
        generation: 9,
        observation: { peerState: 'connected', muted: false, playback: 'unknown' },
      }),
    ).toThrow(/VOICE_STALE_GENERATION/);
    expect(
      f.broker.heartbeat('owner', voice.id, {
        generation: voice.generation,
        observation: { peerState: 'connected', muted: true, playback: 'blocked' },
      }).phase,
    ).toBe('active');
    f.advance(voiceLimits.leaseMs + 1);
    await f.broker.sweep();
    expect(f.broker.get('owner', voice.id).failure?.code).toBe('VOICE_LEASE_EXPIRED');
    expect(f.stop).toHaveBeenCalledTimes(1);
  });
  it('admits handoff once and hang-up preserves durable work but blocks delivery', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    f.event({ type: 'handoff', handoffId: 'h1', text: 'do work' });
    f.event({ type: 'handoff', handoffId: 'h1', text: 'do work' });
    await f.broker.stop('owner', voice.id, voice.generation);
    await Promise.resolve();
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.transport.deliver).not.toHaveBeenCalled();
    expect(f.broker.get('owner', voice.id).phase).toBe('closed');
  });
  it('terminates on backing execution or mutated handoff, without dispatch', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    f.event({ type: 'execution' });
    f.event({ type: 'handoff', handoffId: 'h1', text: 'do work' });
    await Promise.resolve();
    expect(f.broker.get('owner', voice.id).failure?.code).toBe('VOICE_AUTHORITY_VIOLATION');
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledTimes(1);
  });
  it('revokes a changed identity before dispatch and distinguishes delivery acceptance from playback', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request);
    f.changeIdentity();
    f.event({ type: 'handoff', handoffId: 'h1', text: 'do work' });
    await Promise.resolve();
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.broker.get('owner', voice.id).failure?.code).toBe('VOICE_BINDING_CONFLICT');
  });
});
