// Synthetic media objects only: lifecycle/state acceptance, never actual audio proof.
import { afterEach, expect, it, vi } from 'vitest';
import {
  type VoiceCapabilities,
  type VoiceEvent,
  type VoiceSnapshot,
  voiceLimits,
} from '../src/voice/types.js';
import { type VoiceAudio, VoiceController, type VoiceDependencies } from '../src/web/voice.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const controllers: VoiceController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

function browserFixture(available = true) {
  const capabilities: VoiceCapabilities = {
    v: 1,
    available,
    transport: 'webrtc',
    protocol: 'v3',
    outputModality: 'audio',
    billing: 'subscription-only',
    taskMode: available ? 'daemon' : 'disabled',
    interruption: 'unsupported',
    limits: voiceLimits,
    blockers: available
      ? []
      : [
          {
            code: 'VOICE_EXECUTION_ISOLATION_UNVERIFIED',
            message: 'Isolation unavailable',
            retryable: false,
            stage: 'preflight',
          },
        ],
  };
  const voice: VoiceSnapshot = {
    sessionId: 'session',
    threadId: 'thread',
    id: 'lease',
    generation: 7,
    revision: 2,
    phase: 'negotiating',
    taskMode: 'daemon',
    transport: 'webrtc',
    billing: 'subscription-only',
    leaseExpiresAt: 31_000,
    expiresAt: 601_000,
  };
  const track = {
    enabled: true,
    readyState: 'live',
    onended: null as (() => void) | null,
    stop: vi.fn(() => {
      track.readyState = 'ended';
    }),
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const channel = { onclose: null, onerror: null, onmessage: null, close: vi.fn(), send: vi.fn() };
  const peer = {
    connectionState: 'new',
    iceGatheringState: 'complete',
    localDescription: null as RTCSessionDescriptionInit | null,
    onconnectionstatechange: null as (() => void) | null,
    ontrack: null as ((event: Pick<RTCTrackEvent, 'streams' | 'track'>) => void) | null,
    createDataChannel: vi.fn(() => channel),
    addTrack: vi.fn(),
    createOffer: vi.fn(async () => ({ type: 'offer' as const, sdp: 'synthetic-offer' })),
    setLocalDescription: vi.fn(async (value: RTCSessionDescriptionInit) => {
      peer.localDescription = value;
    }),
    setRemoteDescription: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const audio: VoiceAudio = {
    srcObject: null,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    onplaying: null,
    onwaiting: null,
    onended: null,
    onerror: null,
  };
  let receive: ((event: VoiceEvent) => void) | undefined;
  const cancelSubscribe = vi.fn();
  const timers = new Set<() => void>();
  const deps: VoiceDependencies = {
    api: {
      capabilities: vi.fn(async () => capabilities),
      start: vi.fn(async () => ({
        voice,
        answer: { type: 'answer' as const, sdp: 'synthetic-answer' },
      })),
      heartbeat: vi.fn(async () => voice),
      stop: vi.fn(async () => ({ ...voice, phase: 'closed' as const })),
      interrupt: vi.fn(async () => ({ voice, status: 'accepted' as const })),
      subscribe: vi.fn((_id, callback) => {
        receive = callback;
        return cancelSubscribe;
      }),
    },
    capture: vi.fn(async () => stream),
    createPeer: vi.fn(() => peer as unknown as RTCPeerConnection),
    audio,
    uuid: () => 'request',
    unsupported: () => null,
    now: () => 1_000,
    schedule: (callback) => {
      timers.add(callback);
      return () => timers.delete(callback);
    },
  };
  const controller = new VoiceController({ sessionId: 'session', threadId: 'thread' }, deps);
  controllers.push(controller);
  const event = (seq: number, content: Pick<VoiceEvent, 'type' | 'payload'>): VoiceEvent =>
    ({
      v: 1,
      voiceId: voice.id,
      generation: voice.generation,
      revision: voice.revision,
      seq,
      sessionId: 'session',
      threadId: 'thread',
      ...content,
    }) as VoiceEvent;
  return {
    controller,
    deps,
    peer,
    channel,
    audio,
    track,
    stream,
    voice,
    timers,
    cancelSubscribe,
    emit: (value: VoiceEvent) => receive?.(value),
    event,
  };
}

it('unavailable capability prevents capture, peer creation and daemon start even after explicit connect', async () => {
  const f = browserFixture(false);
  await f.controller.loadCapabilities();
  await f.controller.connect();
  expect(f.controller.getState()).toMatchObject({
    phase: 'blocked',
    microphone: 'none',
    remoteTrack: false,
  });
  expect(f.deps.capture).not.toHaveBeenCalled();
  expect(f.deps.createPeer).not.toHaveBeenCalled();
  expect(f.deps.api.start).not.toHaveBeenCalled();
});

it('releases a late granted capture after hangup without starting a provider lease', async () => {
  const f = browserFixture();
  const capture = deferred<MediaStream>();
  vi.mocked(f.deps.capture).mockReturnValue(capture.promise);
  await f.controller.loadCapabilities();
  const connecting = f.controller.connect();
  expect(f.controller.getState().phase).toBe('requesting-mic');
  await f.controller.hangup();
  capture.resolve(f.stream);
  await connecting;
  expect(f.track.stop).toHaveBeenCalledTimes(1);
  expect(f.track.readyState).toBe('ended');
  expect(f.deps.createPeer).not.toHaveBeenCalled();
  expect(f.deps.api.start).not.toHaveBeenCalled();
  expect(f.timers.size).toBe(0);
});

it('does not mistake a remote track, successful play promise or accepted task delivery for rendered playback', async () => {
  const f = browserFixture();
  await f.controller.loadCapabilities();
  await f.controller.connect();
  f.peer.ontrack?.({ streams: [f.stream], track: f.track as unknown as MediaStreamTrack });
  await f.controller.enablePlayback();
  f.emit(
    f.event(1, {
      type: 'voice.result.delivery',
      payload: { runId: 'run', deliveryId: 'delivery', status: 'accepted' },
    }),
  );
  expect(f.controller.getState()).toMatchObject({
    remoteTrack: true,
    playback: 'starting',
    deliveries: [{ status: 'accepted' }],
  });
  f.audio.onplaying?.call({} as HTMLAudioElement, new Event('playing'));
  expect(f.controller.getState().playback).toBe('playing');
  f.audio.onwaiting?.call({} as HTMLAudioElement, new Event('waiting'));
  expect(f.controller.getState().playback).toBe('stalled');
  expect(f.channel.send).not.toHaveBeenCalled();
});

it('reports autoplay rejection explicitly and fully releases synthetic media and lease without a run-cancel API', async () => {
  const f = browserFixture();
  vi.mocked(f.audio.play).mockRejectedValue(new Error('autoplay denied'));
  await f.controller.loadCapabilities();
  await f.controller.connect();
  f.peer.ontrack?.({ streams: [f.stream], track: f.track as unknown as MediaStreamTrack });
  await f.controller.enablePlayback();
  expect(f.controller.getState().playback).toBe('blocked');
  f.controller.setMuted(true);
  expect(f.track.enabled).toBe(false);
  expect(f.controller.getState().microphone).toBe('muted');
  f.controller.setMuted(false);
  expect(f.track.enabled).toBe(true);
  await f.controller.hangup();
  expect(f.track.stop).toHaveBeenCalledTimes(1);
  expect(f.peer.close).toHaveBeenCalledTimes(1);
  expect(f.channel.close).toHaveBeenCalledTimes(1);
  expect(f.cancelSubscribe).toHaveBeenCalledTimes(1);
  expect(f.audio.pause).toHaveBeenCalled();
  expect(f.audio.srcObject).toBeNull();
  expect(f.timers.size).toBe(0);
  expect(f.deps.api.stop).toHaveBeenCalledExactlyOnceWith('lease', {
    generation: 7,
    reason: 'hangup',
  });
  expect(f.controller.getState()).toMatchObject({
    phase: 'ended',
    microphone: 'ended',
    transport: 'closed',
    playback: 'ended',
  });
});

it('fences stale owner/generation/revision events before they can consume the legitimate cursor', async () => {
  const f = browserFixture();
  await f.controller.loadCapabilities();
  await f.controller.connect();
  const transcript = f.event(1, {
    type: 'voice.transcript',
    payload: { itemId: 'item', role: 'assistant', text: 'Bound answer', final: true },
  });
  f.emit({ ...transcript, seq: 100, generation: 6 });
  f.emit({ ...transcript, seq: 100, threadId: 'other-thread' });
  f.emit({ ...transcript, seq: 100, revision: 1 });
  expect(f.controller.getState().transcripts).toEqual([]);
  f.emit(transcript);
  expect(f.controller.getState().transcripts).toEqual([transcript.payload]);
  f.emit({
    ...transcript,
    type: 'voice.transcript',
    payload: { itemId: 'item', role: 'assistant', text: 'Duplicate overwrite', final: true },
  });
  expect(f.controller.getState().transcripts).toEqual([transcript.payload]);
});
