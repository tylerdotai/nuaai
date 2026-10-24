import { createHash, randomUUID } from 'node:crypto';
import {
  type VoiceBinding,
  type VoiceCapabilities,
  type VoiceEvent,
  type VoiceFailure,
  type VoiceFailureCode,
  type VoiceHeartbeatRequest,
  type VoiceSnapshot,
  type VoiceStartRequest,
  type VoiceStartResponse,
  voiceLimits,
} from './types.js';

export class VoiceError extends Error {
  constructor(
    readonly code: VoiceFailureCode,
    readonly status = 502,
    readonly stage: VoiceFailure['stage'] = 'active',
  ) {
    super(code);
  }
  safe(): VoiceFailure {
    return {
      code: this.code,
      message: this.code.replaceAll('_', ' '),
      retryable: false,
      stage: this.stage,
    };
  }
}
export function safeVoiceError(error: unknown): VoiceError {
  return error instanceof VoiceError ? error : new VoiceError('VOICE_PROVIDER_ERROR');
}
export interface VoiceAuthority {
  identitySnapshotId: string;
  workspaceRoot: string;
  authorityKey: string;
}
export type VoiceProviderEvent =
  | { type: 'transcript'; itemId: string; role: 'user' | 'assistant'; text: string; final: boolean }
  | { type: 'handoff'; handoffId: string; text: string }
  | { type: 'execution' }
  | { type: 'error'; error: VoiceError };
export interface VoiceTransport {
  start(
    offer: string,
    receive: (event: VoiceProviderEvent) => void,
    signal: AbortSignal,
  ): Promise<string>;
  stop(): Promise<void>;
  deliver(text: string): Promise<void>;
  interrupt(): Promise<void>;
}
export interface VoiceProvider {
  /** Host-owned policy: never supplied by HTTP callers. Missing proof forbids creation. */
  availability(): Pick<VoiceCapabilities, 'available' | 'taskMode' | 'interruption'> & {
    blocker?: VoiceFailureCode;
  };
  create(): VoiceTransport;
}
export interface VoiceBrokerOptions {
  provider: VoiceProvider;
  authorize(owner: string, binding: VoiceBinding): VoiceAuthority;
  admit(
    binding: VoiceBinding,
    text: string,
    key: string,
    authority: VoiceAuthority,
  ): { runId: string; result: Promise<string> };
  now?: () => number;
  id?: () => string;
  schedule?: (delayMs: number, callback: () => void) => () => void;
}
interface Lease {
  owner: string;
  requestId: string;
  digest: string;
  authority: VoiceAuthority;
  snapshot: VoiceSnapshot;
  transport: VoiceTransport;
  controller: AbortController;
  startedAt: number;
  credentialExpiresAt: number;
  start: Promise<VoiceStartResponse>;
  answer?: string;
  events: VoiceEvent[];
  seq: number;
  bytes: number;
  listeners: Set<(event: VoiceEvent) => void>;
  handoffs: Map<string, string>;
  stop?: Promise<void>;
  cancelTimer?: () => void;
  cancelRetention?: () => void;
  cancelAnswer?: () => void;
}
const terminal = (lease: Lease) => ['closed', 'failed', 'stopping'].includes(lease.snapshot.phase);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max;

export class VoiceBroker {
  private readonly leases = new Map<string, Lease>();
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly schedule: NonNullable<VoiceBrokerOptions['schedule']>;
  private generation = 0;
  private closing = false;
  constructor(private readonly options: VoiceBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.schedule =
      options.schedule ??
      ((delay, callback) => {
        const timer = setTimeout(callback, delay);
        timer.unref();
        return () => clearTimeout(timer);
      });
  }
  capabilities(): VoiceCapabilities {
    const availability = this.options.provider.availability();
    return {
      v: 1,
      available: availability.available && !this.closing,
      transport: 'webrtc',
      protocol: 'v3',
      outputModality: 'audio',
      billing: 'subscription-only',
      taskMode: availability.taskMode,
      interruption: availability.interruption,
      limits: voiceLimits,
      blockers:
        availability.available && !this.closing
          ? []
          : [
              new VoiceError(
                this.closing
                  ? 'VOICE_DISABLED'
                  : (availability.blocker ?? 'VOICE_EXECUTION_ISOLATION_UNVERIFIED'),
                503,
                'preflight',
              ).safe(),
            ],
    };
  }
  async start(
    owner: string,
    request: VoiceStartRequest,
    credentialExpiresAt = Number.POSITIVE_INFINITY,
  ): Promise<VoiceStartResponse> {
    if (!this.capabilities().available)
      throw new VoiceError(this.capabilities().blockers[0].code, 503, 'preflight');
    if (
      !bounded(request?.sessionId, 256) ||
      !bounded(request.threadId, 256) ||
      !bounded(request.requestId, 256) ||
      request.offer?.type !== 'offer' ||
      !bounded(request.offer.sdp, voiceLimits.maxSdpBytes)
    )
      throw new VoiceError('VOICE_INVALID_REQUEST', 400, 'start');
    if (credentialExpiresAt <= this.now()) throw new VoiceError('VOICE_FORBIDDEN', 403, 'start');
    const authority = this.options.authorize(owner, request);
    const hash = digest(
      JSON.stringify([request.sessionId, request.threadId, request.offer.sdp, authority]),
    );
    for (const lease of this.leases.values()) {
      if (lease.owner === owner && lease.requestId === request.requestId) {
        if (lease.digest !== hash) throw new VoiceError('VOICE_REQUEST_CONFLICT', 409, 'start');
        if (
          terminal(lease) ||
          this.now() - lease.startedAt > 30_000 ||
          (!lease.answer && lease.snapshot.phase !== 'starting')
        )
          throw new VoiceError('VOICE_NEGOTIATION_EXPIRED', 409, 'start');
        this.revalidate(lease);
        return lease.start;
      }
    }
    const active = [...this.leases.values()].filter((lease) => !terminal(lease));
    if (
      this.leases.size >= 128 ||
      active.length >= voiceLimits.maxSessions ||
      active.some((lease) => lease.owner === owner || lease.snapshot.threadId === request.threadId)
    )
      throw new VoiceError('VOICE_BUSY', 409, 'start');
    const id = this.id();
    const startedAt = this.now();
    const lease: Lease = {
      owner,
      requestId: request.requestId,
      digest: hash,
      authority,
      snapshot: {
        id,
        generation: ++this.generation,
        revision: 0,
        sessionId: request.sessionId,
        threadId: request.threadId,
        phase: 'starting',
        taskMode: this.capabilities().taskMode,
        transport: 'webrtc',
        billing: 'subscription-only',
        expiresAt: startedAt + voiceLimits.maxDurationMs,
        leaseExpiresAt: Math.min(startedAt + voiceLimits.leaseMs, credentialExpiresAt),
      },
      transport: this.options.provider.create(),
      controller: new AbortController(),
      startedAt,
      credentialExpiresAt,
      start: Promise.resolve(undefined as never),
      events: [],
      seq: 0,
      bytes: 0,
      listeners: new Set(),
      handoffs: new Map(),
    };
    this.leases.set(id, lease);
    this.state(lease, 'starting');
    this.arm(lease);
    lease.cancelRetention = this.schedule(voiceLimits.maxDurationMs + voiceLimits.leaseMs, () => {
      void this.close(lease, new VoiceError('VOICE_DURATION_EXCEEDED')).finally(() =>
        this.leases.delete(id),
      );
    });
    lease.start = this.negotiate(lease, request.offer.sdp);
    return lease.start;
  }
  private async negotiate(lease: Lease, offer: string): Promise<VoiceStartResponse> {
    let cancel = () => {};
    const deadline = new Promise<never>((_, reject) => {
      cancel = this.schedule(voiceLimits.startTimeoutMs, () =>
        reject(new VoiceError('VOICE_NEGOTIATION_TIMEOUT', 504, 'signaling')),
      );
    });
    let abort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new VoiceError('VOICE_NEGOTIATION_EXPIRED', 409, 'signaling'));
      lease.controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const answer = await Promise.race([
        lease.transport.start(
          offer,
          (event) => this.receive(lease, event),
          lease.controller.signal,
        ),
        deadline,
        aborted,
      ]);
      if (terminal(lease)) throw new VoiceError('VOICE_NEGOTIATION_EXPIRED', 409, 'signaling');
      if (!bounded(answer, voiceLimits.maxSdpBytes)) throw new VoiceError('VOICE_PROTOCOL_ERROR');
      this.revalidate(lease);
      lease.answer = answer;
      lease.cancelAnswer = this.schedule(30_000, () => {
        lease.answer = undefined;
        lease.start = Promise.resolve(undefined as never);
      });
      this.state(lease, 'negotiating');
      return { voice: this.snapshot(lease), answer: { type: 'answer', sdp: answer } };
    } catch (error) {
      const failure = lease.snapshot.failure
        ? new VoiceError(lease.snapshot.failure.code, 502, lease.snapshot.failure.stage)
        : safeVoiceError(error);
      await this.close(lease, failure);
      throw failure;
    } finally {
      cancel();
      lease.controller.signal.removeEventListener('abort', abort);
    }
  }
  private owned(owner: string, id: string, generation?: number): Lease {
    const lease = this.leases.get(id);
    if (!lease) throw new VoiceError('VOICE_NOT_FOUND', 404);
    if (lease.owner !== owner) throw new VoiceError('VOICE_FORBIDDEN', 403);
    if (generation !== undefined && lease.snapshot.generation !== generation)
      throw new VoiceError('VOICE_STALE_GENERATION', 409);
    return lease;
  }
  private revalidate(lease: Lease): void {
    // Timers are cleanup backstops, never the authority boundary. Recheck eagerly
    // before every provider event, admission, control, and asynchronous delivery.
    try {
      if (this.now() >= lease.snapshot.expiresAt)
        throw new VoiceError('VOICE_DURATION_EXCEEDED', 409);
      if (this.now() >= Math.min(lease.snapshot.leaseExpiresAt, lease.credentialExpiresAt))
        throw new VoiceError('VOICE_LEASE_EXPIRED', 409);
      const current = this.options.authorize(lease.owner, lease.snapshot);
      if (JSON.stringify(current) !== JSON.stringify(lease.authority))
        throw new VoiceError('VOICE_BINDING_CONFLICT', 409);
    } catch (error) {
      const failure = safeVoiceError(error);
      void this.close(lease, failure);
      throw failure;
    }
  }
  private snapshot(lease: Lease): VoiceSnapshot {
    return structuredClone(lease.snapshot);
  }
  get(owner: string, id: string): VoiceSnapshot {
    const lease = this.owned(owner, id);
    if (!terminal(lease)) {
      try {
        this.revalidate(lease);
      } catch (error) {
        void this.close(lease, safeVoiceError(error));
        throw error;
      }
    }
    return this.snapshot(lease);
  }
  heartbeat(owner: string, id: string, request: VoiceHeartbeatRequest): VoiceSnapshot {
    const lease = this.owned(owner, id, request.generation);
    if (terminal(lease)) return this.snapshot(lease);
    try {
      this.revalidate(lease);
    } catch (error) {
      void this.close(lease, safeVoiceError(error));
      throw error;
    }
    lease.snapshot.leaseExpiresAt = Math.min(
      this.now() + voiceLimits.leaseMs,
      lease.snapshot.expiresAt,
      lease.credentialExpiresAt,
    );
    if (request.observation.peerState === 'connected' && lease.snapshot.phase !== 'starting')
      this.state(lease, 'active');
    this.emit(lease, {
      type: 'voice.observation',
      payload: { ...request.observation, source: 'browser' },
    });
    this.arm(lease);
    return this.snapshot(lease);
  }
  async stop(owner: string, id: string, generation: number): Promise<VoiceSnapshot> {
    const lease = this.owned(owner, id, generation);
    await this.close(lease);
    return this.snapshot(lease);
  }
  async interrupt(owner: string, id: string, generation: number): Promise<VoiceSnapshot> {
    const lease = this.owned(owner, id, generation);
    this.revalidate(lease);
    if (terminal(lease)) throw new VoiceError('VOICE_NEGOTIATION_EXPIRED', 409);
    if (this.capabilities().interruption !== 'provider')
      throw new VoiceError('VOICE_INTERRUPTION_UNSUPPORTED', 409);
    await lease.transport.interrupt();
    return this.snapshot(lease);
  }
  events(owner: string, id: string, after: number): VoiceEvent[] {
    this.get(owner, id);
    const lease = this.owned(owner, id);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new VoiceError('VOICE_INVALID_REQUEST', 400);
    if (after > lease.seq || after < (lease.events[0]?.seq ?? 1) - 1)
      return [{ ...this.envelope(lease), type: 'voice.resync', payload: this.snapshot(lease) }];
    return structuredClone(lease.events.filter((event) => event.seq > after));
  }
  subscribe(owner: string, id: string, receive: (event: VoiceEvent) => void): () => void {
    this.get(owner, id);
    const lease = this.owned(owner, id);
    lease.listeners.add(receive);
    return () => lease.listeners.delete(receive);
  }
  private envelope(lease: Lease) {
    return {
      v: 1 as const,
      voiceId: lease.snapshot.id,
      generation: lease.snapshot.generation,
      revision: lease.snapshot.revision,
      seq: lease.seq,
      sessionId: lease.snapshot.sessionId,
      threadId: lease.snapshot.threadId,
    };
  }
  private emit(lease: Lease, content: Pick<VoiceEvent, 'type' | 'payload'>): void {
    lease.seq++;
    const event = { ...this.envelope(lease), ...content } as VoiceEvent;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > voiceLimits.maxEventBytes) return;
    lease.events.push(event);
    lease.bytes += bytes;
    while (lease.events.length > voiceLimits.maxEvents || lease.bytes > voiceLimits.maxEventBytes) {
      const removed = lease.events.shift();
      lease.bytes -= Buffer.byteLength(JSON.stringify(removed));
    }
    for (const listener of lease.listeners) {
      try {
        listener(structuredClone(event));
      } catch {
        lease.listeners.delete(listener);
      }
    }
  }
  private state(lease: Lease, phase: VoiceSnapshot['phase']): void {
    lease.snapshot.phase = phase;
    lease.snapshot.revision++;
    this.emit(lease, { type: 'voice.state', payload: this.snapshot(lease) });
  }
  private receive(lease: Lease, event: VoiceProviderEvent): void {
    if (terminal(lease)) return;
    try {
      this.revalidate(lease);
      if (event.type === 'execution') throw new VoiceError('VOICE_AUTHORITY_VIOLATION');
      if (event.type === 'error') throw event.error;
      if (event.type === 'transcript') {
        if (!bounded(event.itemId, 256) || !bounded(event.text, voiceLimits.maxTranscriptBytes))
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.emit(lease, {
          type: 'voice.transcript',
          payload: { itemId: event.itemId, role: event.role, text: event.text, final: event.final },
        });
      }
      if (event.type === 'handoff') this.handoff(lease, event.handoffId, event.text);
    } catch (error) {
      void this.close(lease, safeVoiceError(error));
    }
  }
  private handoff(lease: Lease, handoffId: string, text: string): void {
    if (lease.snapshot.phase === 'starting') throw new VoiceError('VOICE_AUTHORITY_VIOLATION');
    if (lease.snapshot.taskMode !== 'daemon') throw new VoiceError('VOICE_AUTHORITY_VIOLATION');
    if (!bounded(handoffId, 256) || !bounded(text, voiceLimits.maxTranscriptBytes))
      throw new VoiceError('VOICE_PROTOCOL_ERROR');
    const hash = digest(text);
    const existing = lease.handoffs.get(handoffId);
    if (existing) {
      if (existing !== hash) throw new VoiceError('VOICE_AUTHORITY_VIOLATION');
      return;
    }
    if (lease.handoffs.size >= 48) throw new VoiceError('VOICE_RATE_LIMITED');
    lease.handoffs.set(handoffId, hash); // claim synchronously before admission or await
    const key = `voice:${lease.snapshot.id}:${lease.snapshot.generation}:${digest(handoffId)}`;
    this.revalidate(lease);
    const run = this.options.admit(lease.snapshot, text, key, lease.authority);
    this.emit(lease, { type: 'voice.run.linked', payload: { handoffId, runId: run.runId } });
    void run.result
      .then(async (result) => {
        if (terminal(lease)) return;
        this.revalidate(lease);
        const deliveryId = digest(key);
        const delivery = (status: 'pending' | 'accepted' | 'unknown' | 'failed') => {
          if (!terminal(lease))
            this.emit(lease, {
              type: 'voice.result.delivery',
              payload: { runId: run.runId, deliveryId, status },
            });
        };
        if (!bounded(result, voiceLimits.maxTranscriptBytes)) {
          delivery('failed');
          return;
        }
        delivery('pending');
        try {
          this.revalidate(lease);
          await lease.transport.deliver(result);
          delivery('accepted');
        } catch {
          delivery('unknown');
        }
      })
      .catch(() => {
        if (!terminal(lease))
          this.emit(lease, {
            type: 'voice.result.delivery',
            payload: { runId: run.runId, deliveryId: digest(key), status: 'failed' },
          });
      });
  }
  private arm(lease: Lease): void {
    lease.cancelTimer?.();
    lease.cancelTimer = this.schedule(
      Math.max(0, Math.min(lease.snapshot.leaseExpiresAt, lease.snapshot.expiresAt) - this.now()),
      () => {
        void this.sweep();
      },
    );
  }
  async sweep(): Promise<void> {
    await Promise.all(
      [...this.leases.values()]
        .filter((lease) => !terminal(lease))
        .map(async (lease) => {
          try {
            this.revalidate(lease);
          } catch (error) {
            await this.close(lease, safeVoiceError(error));
            return;
          }
        }),
    );
  }
  private close(lease: Lease, failure?: VoiceError): Promise<void> {
    if (lease.stop) return lease.stop;
    lease.cancelTimer?.();
    lease.cancelAnswer?.();
    lease.answer = undefined;
    lease.start = Promise.resolve(undefined as never);
    // Install the latch before abort/listener callbacks can reenter close.
    lease.stop = Promise.resolve().then(async () => {
      let cancel = () => {};
      try {
        await Promise.race([
          lease.transport.stop(),
          new Promise<never>((_, reject) => {
            cancel = this.schedule(4_000, () =>
              reject(new VoiceError('VOICE_CLEANUP_FAILED', 502, 'stop')),
            );
          }),
        ]);
      } catch {
        lease.snapshot.failure = new VoiceError('VOICE_CLEANUP_FAILED', 502, 'stop').safe();
      } finally {
        cancel();
        if (lease.snapshot.failure)
          this.emit(lease, { type: 'voice.error', payload: lease.snapshot.failure });
        this.state(lease, lease.snapshot.failure ? 'failed' : 'closed');
        lease.listeners.clear();
      }
    });
    if (failure) lease.snapshot.failure = failure.safe();
    this.state(lease, 'stopping');
    lease.controller.abort();
    return lease.stop;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.leases.values()].map((lease) => this.close(lease)));
    for (const lease of this.leases.values()) lease.cancelRetention?.();
    this.leases.clear();
  }
}
