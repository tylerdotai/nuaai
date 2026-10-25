import {
  type VoiceBinding,
  type VoiceCapabilities,
  type VoiceDelivery,
  type VoiceEvent,
  type VoiceHandoff,
  type VoiceHeartbeatRequest,
  type VoiceInterruptResponse,
  type VoiceSnapshot,
  type VoiceStartRequest,
  type VoiceStartResponse,
  type VoiceStopRequest,
  type VoiceTranscript,
  voiceLimits,
} from '../voice/types.js';

export interface VoiceApi {
  capabilities(): Promise<VoiceCapabilities>;
  start(request: VoiceStartRequest): Promise<VoiceStartResponse>;
  heartbeat(id: string, request: VoiceHeartbeatRequest): Promise<VoiceSnapshot>;
  stop(id: string, request: VoiceStopRequest): Promise<VoiceSnapshot>;
  interrupt(
    id: string,
    request: { generation: number; requestId: string },
  ): Promise<VoiceInterruptResponse>;
  subscribe(id: string, event: (event: VoiceEvent) => void, error: () => void): () => void;
}
export type VoiceAudio = Pick<
  HTMLAudioElement,
  'srcObject' | 'play' | 'pause' | 'onplaying' | 'onwaiting' | 'onended' | 'onerror'
>;
export interface VoiceDependencies {
  api: VoiceApi;
  capture(): Promise<MediaStream>;
  createPeer(): RTCPeerConnection;
  audio: VoiceAudio;
  uuid(): string;
  unsupported(): string | null;
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
export interface VoiceState {
  phase:
    | 'idle'
    | 'preflight'
    | 'blocked'
    | 'requesting-mic'
    | 'negotiating'
    | 'connected'
    | 'ended'
    | 'error';
  capabilities: VoiceCapabilities | null;
  voice: VoiceSnapshot | null;
  microphone: 'none' | 'live' | 'muted' | 'ended';
  transport: RTCPeerConnectionState;
  remoteTrack: boolean;
  playback: 'idle' | 'starting' | 'blocked' | 'playing' | 'stalled' | 'ended' | 'error';
  transcripts: VoiceTranscript[];
  handoffs: VoiceHandoff[];
  deliveries: VoiceDelivery[];
  interruption: 'none' | 'requested' | 'accepted';
  error: string | null;
}
const initialState = (): VoiceState => ({
  phase: 'idle',
  capabilities: null,
  voice: null,
  microphone: 'none',
  transport: 'new',
  remoteTrack: false,
  playback: 'idle',
  transcripts: [],
  handoffs: [],
  deliveries: [],
  interruption: 'none',
  error: null,
});

/** One foreground owner. Provider data-channel messages never grant execution authority. */
export class VoiceController {
  private state = initialState();
  private listeners = new Set<(state: VoiceState) => void>();
  private generation = 0;
  private disposed = false;
  private stream?: MediaStream;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private unsubscribe?: () => void;
  private abort?: AbortController;
  private timers = new Set<() => void>();
  private seq = 0;
  private revision = 0;
  private stopReason: VoiceStopRequest['reason'] = 'hangup';

  constructor(
    private readonly binding: VoiceBinding,
    private readonly deps: VoiceDependencies,
  ) {}
  getState = (): VoiceState => this.state;
  subscribe(listener: (state: VoiceState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private update(patch: Partial<VoiceState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
  private timer(callback: () => void, delay: number): () => void {
    const cancel = this.deps.schedule(
      () => {
        this.timers.delete(cancel);
        callback();
      },
      Math.max(0, delay),
    );
    this.timers.add(cancel);
    return () => {
      cancel();
      this.timers.delete(cancel);
    };
  }
  async loadCapabilities(): Promise<void> {
    if (
      this.disposed ||
      ['preflight', 'requesting-mic', 'negotiating', 'connected'].includes(this.state.phase)
    )
      return;
    const generation = this.generation;
    const unsupported = this.deps.unsupported();
    if (unsupported) {
      this.update({ phase: 'blocked', error: unsupported });
      return;
    }
    this.update({ phase: 'preflight', error: null });
    try {
      const capabilities = await this.deps.api.capabilities();
      if (!this.current(generation)) return;
      const safe =
        capabilities.v === 1 &&
        capabilities.billing === 'subscription-only' &&
        capabilities.transport === 'webrtc' &&
        capabilities.protocol === 'v3' &&
        capabilities.outputModality === 'audio';
      this.update({
        capabilities,
        phase: safe && capabilities.available ? 'idle' : 'blocked',
        error: safe
          ? capabilities.blockers.map(voiceFailureMessage).join(' ') || null
          : 'Unsupported subscription voice contract.',
      });
    } catch (error) {
      if (this.current(generation)) this.update({ phase: 'blocked', error: failureMessage(error) });
    }
  }
  async connect(): Promise<void> {
    if (
      this.disposed ||
      !['idle', 'ended', 'error'].includes(this.state.phase) ||
      !this.state.capabilities?.available
    )
      return;
    const unsupported = this.deps.unsupported();
    if (unsupported) {
      this.update({ phase: 'blocked', error: unsupported });
      return;
    }
    const generation = ++this.generation;
    this.stopReason = 'hangup';
    this.seq = 0;
    this.revision = 0;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.update({
      ...initialState(),
      capabilities: this.state.capabilities,
      phase: 'requesting-mic',
    });
    const cancelNegotiation = this.timer(() => {
      if (this.current(generation))
        void this.fail('Voice connection timed out. Start again explicitly.');
    }, voiceLimits.startTimeoutMs);
    try {
      const stream = await this.deps.capture();
      if (!this.current(generation)) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      const tracks = stream.getAudioTracks();
      if (!tracks.length) throw new Error('No microphone audio track was provided.');
      for (const track of tracks)
        track.onended = () => {
          if (this.current(generation)) void this.fail('Microphone disconnected.');
        };
      this.update({ phase: 'negotiating', microphone: 'live' });
      const peer = this.deps.createPeer();
      this.peer = peer;
      this.channel = peer.createDataChannel('oai-events');
      this.channel.onclose = this.channel.onerror = () => {
        if (this.current(generation)) void this.fail('Voice data channel closed.');
      };
      peer.onconnectionstatechange = () => {
        if (!this.current(generation)) return;
        if (peer.connectionState === 'connected') cancelNegotiation();
        this.update({
          transport: peer.connectionState,
          ...(peer.connectionState === 'connected' ? { phase: 'connected' as const } : {}),
        });
        if (['failed', 'disconnected', 'closed'].includes(peer.connectionState))
          void this.fail('Voice connection lost. Start again explicitly.');
      };
      peer.ontrack = (event) => {
        if (!this.current(generation)) return;
        this.update({ remoteTrack: true });
        this.deps.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void this.enablePlayback();
      };
      this.deps.audio.onplaying = () => {
        if (this.current(generation)) this.update({ playback: 'playing' });
      };
      this.deps.audio.onwaiting = () => {
        if (this.current(generation)) this.update({ playback: 'stalled' });
      };
      this.deps.audio.onended = () => {
        if (this.current(generation)) this.update({ playback: 'ended' });
      };
      this.deps.audio.onerror = () => {
        if (this.current(generation)) this.update({ playback: 'error' });
      };
      for (const track of tracks) peer.addTrack(track, stream);
      await peer.setLocalDescription(await peer.createOffer());
      if (!this.current(generation)) return;
      await waitForIce(peer, signal);
      if (!this.current(generation)) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp || new TextEncoder().encode(sdp).byteLength > voiceLimits.maxSdpBytes)
        throw new Error('Voice negotiation offer is unavailable or too large.');
      // Do not abort a sent start on hang-up: a late response must be stopped by ID.
      // The HTTP adapter bounds this request; the daemon lease handles lost replies.
      const response = await this.deps.api.start({
        ...this.binding,
        requestId: this.deps.uuid(),
        offer: { type: 'offer', sdp },
      });
      if (!this.current(generation)) {
        await this.deps.api.stop(response.voice.id, {
          generation: response.voice.generation,
          reason: this.stopReason,
        });
        return;
      }
      if (
        !this.bindingMatches(response.voice) ||
        response.voice.billing !== 'subscription-only' ||
        response.voice.transport !== 'webrtc'
      ) {
        await this.deps.api.stop(response.voice.id, {
          generation: response.voice.generation,
          reason: 'client_error',
        });
        throw new Error('Voice session binding was rejected.');
      }
      this.revision = response.voice.revision;
      this.update({ voice: response.voice });
      if (['closed', 'failed', 'stopping'].includes(response.voice.phase))
        throw new VoicePublicError(
          response.voice.failure
            ? voiceFailureMessage(response.voice.failure)
            : 'Voice session ended during negotiation.',
        );
      if (
        response.answer.type !== 'answer' ||
        new TextEncoder().encode(response.answer.sdp).byteLength > voiceLimits.maxSdpBytes
      )
        throw new Error('Voice negotiation answer was rejected.');
      await peer.setRemoteDescription(response.answer);
      if (!this.current(generation)) return;
      this.unsubscribe = this.deps.api.subscribe(
        response.voice.id,
        (event) => {
          if (this.current(generation)) this.acceptEvent(event);
        },
        () => {
          if (this.current(generation))
            void this.fail('Voice event connection lost. Start again explicitly.');
        },
      );
      this.heartbeat(generation);
    } catch (error) {
      if (this.current(generation)) await this.fail(failureMessage(error));
    }
  }
  private bindingMatches(value: VoiceBinding): boolean {
    return value.sessionId === this.binding.sessionId && value.threadId === this.binding.threadId;
  }
  private applySnapshot(snapshot: VoiceSnapshot): void {
    const voice = this.state.voice;
    if (
      !voice ||
      !this.bindingMatches(snapshot) ||
      snapshot.id !== voice.id ||
      snapshot.generation !== voice.generation ||
      snapshot.revision < this.revision
    )
      return;
    this.revision = snapshot.revision;
    this.update({ voice: snapshot });
    if (snapshot.phase === 'failed')
      void this.fail(
        snapshot.failure ? voiceFailureMessage(snapshot.failure) : 'Voice session failed.',
      );
    else if (snapshot.phase === 'closed' || snapshot.phase === 'stopping') void this.hangup();
  }
  private acceptEvent(event: VoiceEvent): void {
    const voice = this.state.voice;
    if (
      !voice ||
      event.v !== 1 ||
      !this.bindingMatches(event) ||
      event.voiceId !== voice.id ||
      event.generation !== voice.generation ||
      event.seq <= this.seq ||
      event.revision < this.revision
    )
      return;
    if (
      (event.type === 'voice.state' || event.type === 'voice.resync') &&
      (!this.bindingMatches(event.payload) ||
        event.payload.id !== voice.id ||
        event.payload.generation !== voice.generation ||
        event.payload.revision !== event.revision)
    )
      return;
    this.seq = event.seq;
    this.revision = event.revision;
    switch (event.type) {
      case 'voice.state':
      case 'voice.resync':
        if (event.type === 'voice.resync')
          this.update({ transcripts: this.state.transcripts.filter((item) => item.final) });
        this.applySnapshot(event.payload);
        break;
      case 'voice.transcript': {
        const item = event.payload;
        if (
          typeof item.text !== 'string' ||
          new TextEncoder().encode(item.text).byteLength > voiceLimits.maxTranscriptBytes
        )
          return;
        const old = this.state.transcripts.find(
          (entry) => entry.itemId === item.itemId && entry.role === item.role,
        );
        if (old?.final && !item.final) return;
        this.update({
          transcripts: [...this.state.transcripts.filter((entry) => entry !== old), item].slice(
            -100,
          ),
        });
        break;
      }
      case 'voice.run.linked':
        this.update({
          handoffs: [
            ...this.state.handoffs.filter((item) => item.handoffId !== event.payload.handoffId),
            event.payload,
          ].slice(-50),
        });
        break;
      case 'voice.result.delivery':
        this.update({
          deliveries: [
            ...this.state.deliveries.filter((item) => item.deliveryId !== event.payload.deliveryId),
            event.payload,
          ].slice(-50),
        });
        break;
      case 'voice.error':
        void this.fail(voiceFailureMessage(event.payload));
        break;
      case 'voice.observation':
        break; // Browser observations are not authoritative playback evidence.
    }
  }
  private heartbeat(generation: number): void {
    if (!this.current(generation)) return;
    const voice = this.state.voice;
    if (!voice) return;
    const remaining = Math.min(voice.expiresAt, voice.leaseExpiresAt) - this.deps.now();
    if (remaining <= 0) {
      void this.fail('Voice lease expired. Start again explicitly.');
      return;
    }
    this.timer(
      () => {
        if (!this.current(generation)) return;
        void this.deps.api
          .heartbeat(voice.id, {
            generation: voice.generation,
            observation: {
              peerState: this.state.transport,
              muted: this.state.microphone === 'muted',
              playback:
                this.state.playback === 'playing'
                  ? 'playing'
                  : this.state.playback === 'blocked'
                    ? 'blocked'
                    : 'unknown',
            },
          })
          .then((snapshot) => {
            if (!this.current(generation)) return;
            this.applySnapshot(snapshot);
            this.heartbeat(generation);
          })
          .catch((error: unknown) => {
            if (this.current(generation)) void this.fail(failureMessage(error));
          });
      },
      Math.min(voiceLimits.heartbeatIntervalMs, remaining),
    );
    // A hung heartbeat must not leave capture alive beyond the known lease.
    this.timer(() => {
      if (
        this.current(generation) &&
        this.state.voice &&
        Math.min(this.state.voice.expiresAt, this.state.voice.leaseExpiresAt) <= this.deps.now()
      )
        void this.fail('Voice lease expired. Start again explicitly.');
    }, remaining);
  }
  setMuted(muted: boolean): void {
    if (!this.stream) return;
    for (const track of this.stream.getAudioTracks()) track.enabled = !muted;
    this.update({ microphone: muted ? 'muted' : 'live' });
  }
  async enablePlayback(): Promise<void> {
    if (!this.state.remoteTrack || !this.peer) return;
    const generation = this.generation;
    this.update({ playback: 'starting' });
    try {
      await this.deps.audio.play();
    } catch {
      if (this.current(generation)) this.update({ playback: 'blocked' });
    }
  }
  async interrupt(): Promise<void> {
    const voice = this.state.voice;
    if (!voice || this.state.capabilities?.interruption !== 'provider') return;
    const generation = this.generation;
    this.update({ interruption: 'requested' });
    try {
      await this.deps.api.interrupt(voice.id, {
        generation: voice.generation,
        requestId: this.deps.uuid(),
      });
      if (this.current(generation)) this.update({ interruption: 'accepted' });
    } catch (error) {
      if (this.current(generation)) this.update({ error: failureMessage(error) });
    }
  }
  private async fail(message: string): Promise<void> {
    const stopped = this.hangup('client_error');
    const generation = this.generation;
    await stopped;
    if (this.current(generation)) this.update({ phase: 'error', error: message });
  }
  async hangup(reason: VoiceStopRequest['reason'] = 'hangup'): Promise<void> {
    this.stopReason = reason;
    const generation = ++this.generation;
    this.abort?.abort();
    this.abort = undefined;
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.stream = undefined;
    if (this.channel) {
      this.channel.onclose = this.channel.onerror = null;
      this.channel.close();
      this.channel = undefined;
    }
    if (this.peer) {
      this.peer.ontrack = this.peer.onconnectionstatechange = null;
      this.peer.close();
      this.peer = undefined;
    }
    const audio = this.deps.audio;
    audio.onplaying = audio.onwaiting = audio.onended = audio.onerror = null;
    audio.pause();
    audio.srcObject = null;
    const voice = this.state.voice;
    this.update({
      phase: 'ended',
      voice: null,
      microphone: 'ended',
      transport: 'closed',
      playback: 'ended',
      remoteTrack: false,
      deliveries: this.state.deliveries.map((delivery) =>
        delivery.status === 'pending' ? { ...delivery, status: 'interrupted' } : delivery,
      ),
    });
    if (voice) {
      try {
        await this.deps.api.stop(voice.id, { generation: voice.generation, reason });
      } catch {
        if (this.current(generation))
          this.update({
            error:
              'Local media stopped. Daemon stop was not confirmed; the bounded lease will expire.',
          });
      }
    }
  }
  dispose(): void {
    void this.hangup('navigation');
    this.disposed = true;
    this.listeners.clear();
  }
}

/** Fixed actionable guidance for typed subscription failures, never upstream diagnostics. */
export function voiceFailureMessage(failure: { code: string; message: string }): string {
  switch (failure.code) {
    case 'VOICE_CODEX_LOGIN_REQUIRED':
      return 'Check the existing Codex/ChatGPT sign-in on this computer, then check voice availability and start again. No API key is used.';
    case 'VOICE_SUBSCRIPTION_REQUIRED':
      return 'An eligible ChatGPT subscription is required for voice. Text chat remains available.';
    case 'VOICE_ACCESS_DENIED':
      return 'This account does not have access to subscription voice. Text chat remains available.';
    case 'VOICE_QUOTA_EXCEEDED':
      return 'The account voice quota has been reached. Try again when quota is available; there is no paid API fallback.';
    case 'VOICE_RATE_LIMITED':
      return 'Voice is rate limited. Wait before you start again explicitly; voice will not reconnect automatically.';
    default:
      return failure.message;
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      return 'Microphone permission denied. Check browser site settings, then start again.';
    if (error.name === 'NotFoundError')
      return 'No microphone found. Connect an audio input device.';
    if (error.name === 'NotReadableError')
      return 'Microphone is busy or unavailable. Check operating-system audio permissions.';
  }
  // Never surface browser/provider negotiation exceptions (which may include SDP).
  return error instanceof VoicePublicError
    ? error.message
    : 'Voice could not continue. Check microphone access and daemon status, then start again.';
}
/** Only explicit sanitized daemon/UI messages may be displayed to the operator. */
export class VoicePublicError extends Error {}

function waitForIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      peer.removeEventListener('icegatheringstatechange', changed);
      signal.removeEventListener('abort', aborted);
    };
    const changed = () => {
      if (peer.iceGatheringState === 'complete') {
        cleanup();
        resolve();
      }
    };
    const aborted = () => {
      cleanup();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    peer.addEventListener('icegatheringstatechange', changed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else changed();
  });
}
