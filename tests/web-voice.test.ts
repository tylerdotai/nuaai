import { describe, expect, it, vi } from 'vitest';
import {
  type VoiceCapabilities,
  type VoiceEvent,
  type VoiceSnapshot,
  voiceLimits,
} from '../src/voice/types.js';
import { VoiceController, type VoiceDependencies } from '../src/web/voice.js';

const binding = { sessionId: 'session-a', threadId: 'thread-a' };
const capabilities: VoiceCapabilities = {
  v: 1,
  available: true,
  transport: 'webrtc',
  protocol: 'v3',
  outputModality: 'audio',
  billing: 'subscription-only',
  taskMode: 'daemon',
  interruption: 'provider',
  limits: voiceLimits,
  blockers: [],
};
const lease: VoiceSnapshot = {
  ...binding,
  id: 'lease-a',
  generation: 1,
  revision: 1,
  phase: 'active',
  taskMode: 'daemon',
  transport: 'webrtc',
  billing: 'subscription-only',
  expiresAt: 600_000,
  leaseExpiresAt: 30_000,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const track = { stop: vi.fn(), enabled: true, onended: null };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const channel = { close: vi.fn(), onerror: null, onclose: null };
  const peer = {
    connectionState: 'new',
    iceGatheringState: 'complete',
    localDescription: { type: 'offer', sdp: 'fixture-offer' },
    createDataChannel: vi.fn(() => channel),
    addTrack: vi.fn(),
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'fixture-offer' })),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined),
    close: vi.fn(),
    ontrack: null,
    onconnectionstatechange: null,
  };
  const audio = {
    srcObject: null,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    onplaying: null,
    onwaiting: null,
    onended: null,
    onerror: null,
  };
  const unsubscribe = vi.fn();
  const timers = new Set<() => void>();
  const api = {
    capabilities: vi.fn(async () => capabilities),
    start: vi.fn(async () => ({
      voice: lease,
      answer: { type: 'answer' as const, sdp: 'fixture-answer' },
    })),
    heartbeat: vi.fn(async () => lease),
    stop: vi.fn(async () => ({ ...lease, phase: 'closed' as const })),
    interrupt: vi.fn(async () => ({ voice: lease, status: 'accepted' as const })),
    subscribe: vi.fn(
      (_id: string, _event: (event: VoiceEvent) => void, _error: () => void) => unsubscribe,
    ),
  };
  const dependencies = {
    api,
    capture: vi.fn(async () => stream),
    createPeer: vi.fn(() => peer),
    audio,
    uuid: () => 'request-a',
    unsupported: () => null,
    now: () => 0,
    schedule: (callback: () => void) => {
      const fire = () => {
        timers.delete(fire);
        callback();
      };
      timers.add(fire);
      return () => {
        timers.delete(fire);
      };
    },
  } as unknown as VoiceDependencies;
  const controller = new VoiceController(binding, dependencies);
  return {
    controller,
    dependencies,
    api,
    track,
    stream,
    peer,
    channel,
    audio,
    unsubscribe,
    timers,
  };
}

describe('foreground voice lifecycle', () => {
  it('does not create duplicate connections while permission is pending and disposal fences late capture', async () => {
    const f = fixture();
    const pending = deferred<MediaStream>();
    f.dependencies.capture = vi.fn(() => pending.promise);
    await f.controller.loadCapabilities();
    const first = f.controller.connect();
    await f.controller.connect();
    const listener = vi.fn();
    f.controller.subscribe(listener);
    f.controller.dispose();
    const updatesAtDisposal = listener.mock.calls.length;
    pending.resolve(f.stream);
    await first;
    expect(f.dependencies.capture).toHaveBeenCalledTimes(1);
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.api.start).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(updatesAtDisposal);
    expect(f.timers.size).toBe(0);
  });

  it('aborts ICE gathering and removes its listeners when navigation ends negotiation', async () => {
    const f = fixture();
    f.peer.iceGatheringState = 'gathering';
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    Object.assign(f.peer, { addEventListener, removeEventListener });
    await f.controller.loadCapabilities();
    const connecting = f.controller.connect();
    await vi.waitFor(() => expect(addEventListener).toHaveBeenCalled());
    await f.controller.hangup('navigation');
    await connecting;
    expect(removeEventListener).toHaveBeenCalledWith(
      'icegatheringstatechange',
      expect.any(Function),
    );
    expect(f.api.start).not.toHaveBeenCalled();
    expect(f.peer.close).toHaveBeenCalledTimes(1);
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.timers.size).toBe(0);
  });

  it('keeps a connection deadline after SDP answer until the peer really connects', async () => {
    const f = fixture();
    await f.controller.loadCapabilities();
    await f.controller.connect();
    const timeout = [...f.timers][0];
    timeout();
    await vi.waitFor(() => expect(f.controller.getState().phase).toBe('error'));
    expect(f.controller.getState().error).toContain('timed out');
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.api.stop).toHaveBeenCalledTimes(1);
  });

  it('reports peer connection separately from playback and sends bounded observations only', async () => {
    const f = fixture();
    await f.controller.loadCapabilities();
    await f.controller.connect();
    const peer = f.peer as unknown as RTCPeerConnection;
    f.peer.connectionState = 'connected';
    peer.onconnectionstatechange?.(new Event('connectionstatechange'));
    expect(f.controller.getState().phase).toBe('connected');
    expect(f.controller.getState().remoteTrack).toBe(false);
    expect(f.controller.getState().playback).toBe('idle');
    [...f.timers][0]();
    await vi.waitFor(() => expect(f.api.heartbeat).toHaveBeenCalled());
    expect(f.api.heartbeat).toHaveBeenCalledWith(lease.id, {
      generation: 1,
      observation: { peerState: 'connected', muted: false, playback: 'unknown' },
    });
    await f.controller.hangup();
    expect(f.timers.size).toBe(0);
  });

  it('discards late play rejections and failed stop responses after a replacement lease starts', async () => {
    const f = fixture();
    await f.controller.loadCapabilities();
    await f.controller.connect();
    const blocked = deferred<void>();
    f.audio.play.mockImplementationOnce(() =>
      blocked.promise.then(() => {
        throw new DOMException('blocked', 'NotAllowedError');
      }),
    );
    (f.peer as unknown as RTCPeerConnection).ontrack?.({
      streams: [f.stream],
    } as unknown as RTCTrackEvent);
    const stop = deferred<Awaited<ReturnType<typeof f.api.stop>>>();
    f.api.stop.mockImplementationOnce(() =>
      stop.promise.then(() => {
        throw new Error('old stop failed');
      }),
    );
    const hangingUp = f.controller.hangup();
    f.api.start.mockResolvedValueOnce({
      voice: { ...lease, id: 'lease-b', generation: 2 },
      answer: { type: 'answer', sdp: 'fixture-answer' },
    });
    await f.controller.connect();
    blocked.resolve();
    stop.resolve({ ...lease, phase: 'closed' });
    await hangingUp;
    expect(f.controller.getState().voice?.id).toBe('lease-b');
    expect(f.controller.getState().playback).toBe('idle');
    expect(f.controller.getState().error).toBeNull();
  });
  it('distinguishes denied, absent, and busy microphone failures without leaking negotiation exceptions', async () => {
    for (const [name, expected] of [
      ['NotAllowedError', 'permission denied'],
      ['NotFoundError', 'No microphone found'],
      ['NotReadableError', 'busy or unavailable'],
      ['OperationError', 'could not continue'],
    ] as const) {
      const f = fixture();
      f.dependencies.capture = vi.fn(async () => {
        throw new DOMException('fixture-private-negotiation', name);
      });
      await f.controller.loadCapabilities();
      await f.controller.connect();
      expect(f.controller.getState().error).toContain(expected);
      expect(f.controller.getState().error).not.toContain('fixture-private-negotiation');
      expect(f.dependencies.createPeer).not.toHaveBeenCalled();
      expect(f.api.start).not.toHaveBeenCalled();
      expect(f.timers.size).toBe(0);
    }
  });

  it('rejects insecure or incompatible billing contracts before capture and keeps failures private', async () => {
    const f = fixture();
    f.dependencies.unsupported = () => 'Use HTTPS to enable voice.';
    await f.controller.loadCapabilities();
    expect(f.api.capabilities).not.toHaveBeenCalled();
    await f.controller.connect();
    expect(f.dependencies.capture).not.toHaveBeenCalled();
    f.dependencies.unsupported = () => null;
    f.api.capabilities.mockResolvedValue({
      ...capabilities,
      billing: 'api-key',
    } as unknown as VoiceCapabilities);
    await f.controller.loadCapabilities();
    await f.controller.connect();
    expect(f.dependencies.capture).not.toHaveBeenCalled();
    expect(f.controller.getState().phase).toBe('blocked');
  });

  it('bounds pending permission acquisition and stops a late stream after timeout', async () => {
    const f = fixture();
    const pending = deferred<MediaStream>();
    f.dependencies.capture = () => pending.promise;
    await f.controller.loadCapabilities();
    const connecting = f.controller.connect();
    const timeout = [...f.timers][0];
    timeout();
    pending.resolve(f.stream);
    await connecting;
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.dependencies.createPeer).not.toHaveBeenCalled();
    expect(f.api.start).not.toHaveBeenCalled();
    expect(f.controller.getState().phase).toBe('error');
  });

  it('fences event ownership/generation/sequence/revision and never executes task or approval requests', async () => {
    const f = fixture();
    await f.controller.loadCapabilities();
    await f.controller.connect();
    const event = f.api.subscribe.mock.calls[0][1];
    const base = {
      v: 1 as const,
      ...binding,
      voiceId: lease.id,
      generation: 1,
      revision: 1,
      seq: 1,
    };
    const transcript: VoiceEvent = {
      ...base,
      type: 'voice.transcript',
      payload: { itemId: 'i1', role: 'user', text: 'fixture text', final: true },
    };
    event({ ...transcript, threadId: 'wrong-thread' });
    event({ ...transcript, voiceId: 'wrong-lease' });
    event({ ...transcript, generation: 2 });
    expect(f.controller.getState().transcripts).toEqual([]);
    event(transcript);
    event({ ...transcript, payload: { ...transcript.payload, text: 'duplicate text' } });
    event({
      ...base,
      seq: 2,
      revision: 2,
      type: 'voice.state',
      payload: { ...lease, generation: 2, revision: 2 },
    });
    expect(f.controller.getState().voice?.revision).toBe(1);
    event({
      ...base,
      seq: 2,
      revision: 2,
      type: 'voice.state',
      payload: { ...lease, revision: 2 },
    });
    expect(f.controller.getState().voice?.revision).toBe(2);
    event({ ...transcript, seq: 3, payload: { ...transcript.payload, text: 'stale revision' } });
    expect(f.controller.getState().transcripts.map((item) => item.text)).toEqual(['fixture text']);
    event({
      ...base,
      seq: 4,
      revision: 2,
      type: 'voice.run.linked',
      payload: { runId: 'r1', handoffId: 'h1' },
    });
    event({
      ...base,
      seq: 5,
      revision: 2,
      type: 'voice.result.delivery',
      payload: { runId: 'r1', deliveryId: 'd1', status: 'failed' },
    });
    expect(f.controller.getState().handoffs).toEqual([{ runId: 'r1', handoffId: 'h1' }]);
    expect(f.controller.getState().deliveries[0].status).toBe('failed');
    event({
      ...base,
      seq: 6,
      revision: 2,
      type: 'voice.result.delivery',
      payload: { runId: 'r2', deliveryId: 'd2', status: 'pending' },
    });
    await f.controller.hangup();
    expect(
      f.controller.getState().deliveries.find((item) => item.deliveryId === 'd2')?.status,
    ).toBe('interrupted');
    event({ ...transcript, seq: 7, revision: 2 });
    expect(f.controller.getState().phase).toBe('ended');
    expect(f.api.start).toHaveBeenCalledTimes(1);
    expect(f.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
  });

  it('ends media on stream failure, device loss, or expired lease without automatic reacquisition', async () => {
    for (const fault of ['stream', 'device', 'lease'] as const) {
      const f = fixture();
      await f.controller.loadCapabilities();
      await f.controller.connect();
      if (fault === 'stream') f.api.subscribe.mock.calls[0][2]();
      else if (fault === 'device')
        (f.track as unknown as MediaStreamTrack).onended?.(new Event('ended'));
      else {
        f.dependencies.now = () => 31_000;
        for (const timer of [...f.timers]) timer();
      }
      await vi.waitFor(() => expect(f.controller.getState().phase).toBe('error'));
      expect(f.track.stop).toHaveBeenCalledTimes(1);
      expect(f.peer.close).toHaveBeenCalledTimes(1);
      expect(f.dependencies.capture).toHaveBeenCalledTimes(1);
      expect(f.api.stop).toHaveBeenCalledTimes(1);
      expect(f.timers.size).toBe(0);
    }
  });

  it('speech interruption only requests provider control and does not stop the durable run or claim silence', async () => {
    const f = fixture();
    await f.controller.loadCapabilities();
    await f.controller.connect();
    await f.controller.interrupt();
    expect(f.api.interrupt).toHaveBeenCalledWith(lease.id, {
      generation: 1,
      requestId: 'request-a',
    });
    expect(f.controller.getState().interruption).toBe('accepted');
    expect(f.api.stop).not.toHaveBeenCalled();
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.controller.getState().playback).not.toBe('playing');
  });
  it('does not capture on preflight, and fails closed for unavailable subscription capability', async () => {
    const f = fixture();
    f.api.capabilities.mockResolvedValue({
      ...capabilities,
      available: false,
      blockers: [
        {
          code: 'VOICE_EXECUTION_ISOLATION_UNVERIFIED',
          message: 'Backing tools cannot be isolated.',
          retryable: false,
          stage: 'preflight',
        },
      ],
    });
    await f.controller.loadCapabilities();
    await f.controller.connect();
    expect(f.dependencies.capture).not.toHaveBeenCalled();
    expect(f.api.start).not.toHaveBeenCalled();
    expect(f.dependencies.createPeer).not.toHaveBeenCalled();
    expect(f.controller.getState().error).toContain('Backing tools cannot be isolated');
  });

  it('requires explicit connect, mutes only input, and releases all media/lease resources on hang-up without cancelling work', async () => {
    const f = fixture();
    await f.controller.loadCapabilities();
    expect(f.dependencies.capture).not.toHaveBeenCalled();
    await f.controller.connect();
    expect(f.api.start).toHaveBeenCalledWith(
      expect.objectContaining({
        ...binding,
        requestId: 'request-a',
        offer: { type: 'offer', sdp: 'fixture-offer' },
      }),
    );
    f.controller.setMuted(true);
    expect(f.track.enabled).toBe(false);
    f.controller.setMuted(false);
    expect(f.track.enabled).toBe(true);
    await f.controller.hangup();
    await f.controller.hangup();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.peer.close).toHaveBeenCalledTimes(1);
    expect(f.channel.close).toHaveBeenCalledTimes(1);
    expect(f.audio.pause).toHaveBeenCalled();
    expect(f.audio.srcObject).toBeNull();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.api.stop).toHaveBeenCalledTimes(1);
    expect(f.api.stop).toHaveBeenCalledWith('lease-a', { generation: 1, reason: 'hangup' });
    expect(f.timers.size).toBe(0);
    expect(f.controller.getState().phase).toBe('ended');
  });

  it('stops a microphone returned after hang-up and never starts a peer/provider session', async () => {
    const f = fixture();
    const pending = deferred<MediaStream>();
    f.dependencies.capture = vi.fn(() => pending.promise);
    await f.controller.loadCapabilities();
    const connecting = f.controller.connect();
    await f.controller.hangup();
    pending.resolve(f.stream);
    await connecting;
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.api.start).not.toHaveBeenCalled();
    expect(f.peer.addTrack).not.toHaveBeenCalled();
  });

  it('stops a late lease response using its original generation without reviving the UI', async () => {
    const f = fixture();
    const pending = deferred<Awaited<ReturnType<typeof f.api.start>>>();
    f.api.start.mockImplementation(() => pending.promise);
    await f.controller.loadCapabilities();
    const connecting = f.controller.connect();
    await vi.waitFor(() => expect(f.api.start).toHaveBeenCalled());
    await f.controller.hangup('navigation');
    pending.resolve({ voice: lease, answer: { type: 'answer', sdp: 'fixture-answer' } });
    await connecting;
    expect(f.api.stop).toHaveBeenCalledWith('lease-a', { generation: 1, reason: 'navigation' });
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.controller.getState().phase).toBe('ended');
  });

  it('never equates a remote track or play promise with audible playback, and recovers blocked playback only by explicit action', async () => {
    const f = fixture();
    await f.controller.loadCapabilities();
    await f.controller.connect();
    f.audio.play.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    const remote = { getTracks: () => [] } as unknown as MediaStream;
    const peer = f.peer as unknown as RTCPeerConnection;
    peer.ontrack?.({ streams: [remote] } as unknown as RTCTrackEvent);
    await vi.waitFor(() => expect(f.controller.getState().playback).toBe('blocked'));
    expect(f.controller.getState().remoteTrack).toBe(true);
    await f.controller.enablePlayback();
    expect(f.controller.getState().playback).toBe('starting');
    (f.audio as unknown as HTMLAudioElement).onplaying?.(new Event('playing'));
    expect(f.controller.getState().playback).toBe('playing');
  });
});
