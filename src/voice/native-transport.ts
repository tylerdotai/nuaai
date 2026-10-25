import {
  type VoiceDeliveryContext,
  VoiceError,
  type VoiceProviderEvent,
  type VoiceTransport,
} from './broker.js';
import { type NativeVoiceWire, nativeText } from './native-wire.js';
import { voiceLimits } from './types.js';

export type NativeVoiceProfile = 'offline-memory-v1' | 'subscription-webrtc-v3';
const offlineErrors = [
  'VOICE_PROTOCOL_ERROR',
  'VOICE_PROVIDER_ERROR',
  'VOICE_PAYLOAD_TOO_LARGE',
] as const;
const liveErrors = [
  ...offlineErrors,
  'VOICE_CODEX_LOGIN_REQUIRED',
  'VOICE_SUBSCRIPTION_REQUIRED',
  'VOICE_ACCESS_DENIED',
  'VOICE_QUOTA_EXCEEDED',
  'VOICE_RATE_LIMITED',
  'VOICE_AUTHORITY_VIOLATION',
  'VOICE_PROVIDER_DISCONNECTED',
  'VOICE_NEGOTIATION_TIMEOUT',
  'VOICE_CLEANUP_FAILED',
] as const;
type NativeErrorCode = (typeof liveErrors)[number];
type ReadyEvent = Extract<VoiceProviderEvent, { type: 'handoff' | 'transcript' }>;

export type ToHelper =
  | { v: 1; type: 'hello' | 'close'; commandId: number }
  | { v: 1; type: 'start'; commandId: number; offer: string }
  | {
      v: 1;
      type: 'append';
      commandId: number;
      handoffId: string;
      deliveryId: string;
      text: string;
    };
export type FromHelper =
  | {
      v: 1;
      type: 'hello';
      commandId: number;
      profile: NativeVoiceProfile;
      interruption: 'unsupported';
    }
  | { v: 1; type: 'answer'; commandId: number; sdp: string }
  | { v: 1; type: 'control_ready' | 'closed'; commandId: number }
  | { v: 1; type: 'handoff'; handoffId: string; text: string }
  | {
      v: 1;
      type: 'transcript';
      itemId: string;
      role: 'user' | 'assistant';
      text: string;
      status: 'partial' | 'final';
    }
  | {
      v: 1;
      type: 'delivery';
      commandId: number;
      handoffId: string;
      deliveryId: string;
      status: 'accepted' | 'unknown';
    }
  | {
      v: 1;
      type: 'error';
      commandId?: number;
      code: NativeErrorCode;
    };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: VoiceError) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const id = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
function decode(value: unknown, expectedProfile: NativeVoiceProfile): FromHelper {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new VoiceError('VOICE_PROTOCOL_ERROR');
  const m = value as Record<string, unknown>;
  const exact = (...keys: string[]) => {
    if (
      m.v !== 1 ||
      Object.keys(m).length !== keys.length + 2 ||
      !['v', 'type', ...keys].every((key) => Object.hasOwn(m, key))
    )
      throw new VoiceError('VOICE_PROTOCOL_ERROR');
  };
  const command = () => {
    if (!id(m.commandId)) throw new VoiceError('VOICE_PROTOCOL_ERROR');
  };
  switch (m.type) {
    case 'hello':
      exact('commandId', 'profile', 'interruption');
      command();
      if (m.profile !== expectedProfile || m.interruption !== 'unsupported')
        throw new VoiceError('VOICE_PROTOCOL_ERROR');
      break;
    case 'answer':
      exact('commandId', 'sdp');
      command();
      if (!nativeText(m.sdp, voiceLimits.maxSdpBytes)) throw new VoiceError('VOICE_PROTOCOL_ERROR');
      break;
    case 'control_ready':
    case 'closed':
      exact('commandId');
      command();
      break;
    case 'handoff':
      exact('handoffId', 'text');
      if (!nativeText(m.handoffId, 256) || !nativeText(m.text, voiceLimits.maxTranscriptBytes))
        throw new VoiceError('VOICE_PROTOCOL_ERROR');
      break;
    case 'transcript':
      exact('itemId', 'role', 'text', 'status');
      if (
        expectedProfile !== 'subscription-webrtc-v3' ||
        !nativeText(m.itemId, 256) ||
        !nativeText(m.text, voiceLimits.maxTranscriptBytes) ||
        (m.role !== 'user' && m.role !== 'assistant') ||
        (m.status !== 'partial' && m.status !== 'final')
      )
        throw new VoiceError('VOICE_PROTOCOL_ERROR');
      break;
    case 'delivery':
      exact('commandId', 'handoffId', 'deliveryId', 'status');
      command();
      if (
        !nativeText(m.handoffId, 256) ||
        !nativeText(m.deliveryId, 256) ||
        (m.status !== 'accepted' && m.status !== 'unknown')
      )
        throw new VoiceError('VOICE_PROTOCOL_ERROR');
      break;
    case 'error':
      exact(...(Object.hasOwn(m, 'commandId') ? ['commandId', 'code'] : ['code']));
      if (Object.hasOwn(m, 'commandId')) command();
      if (
        typeof m.code !== 'string' ||
        !(expectedProfile === 'subscription-webrtc-v3' ? liveErrors : offlineErrors).some(
          (code) => code === m.code,
        )
      )
        throw new VoiceError('VOICE_PROTOCOL_ERROR');
      break;
    default:
      throw new VoiceError('VOICE_PROTOCOL_ERROR');
  }
  return m as FromHelper;
}

/** Profile is chosen by the trusted host, never negotiated from untrusted frames. */
export class NativeVoiceTransport implements VoiceTransport {
  private receive: (event: VoiceProviderEvent) => void = () => {};
  private unsubscribe = () => {};
  private nextId = 0;
  private helloId = 0;
  private startId = 0;
  private closeId = 0;
  private started = false;
  private terminal = false;
  private answered = false;
  private answerAccepted = false;
  private queuedEvents: ReadyEvent[] = [];
  private queuedBytes = 0;
  private ready = false;
  private hello = deferred<void>();
  private answer = deferred<string>();
  private closed = deferred<void>();
  private timer?: ReturnType<typeof setTimeout>;
  private removeAbort = () => {};
  private termination?: Promise<void>;
  private appends = new Map<
    number,
    {
      context: VoiceDeliveryContext;
      result: ReturnType<typeof deferred<void>>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closingAppends = new Map<number, VoiceDeliveryContext>();
  private handoffs = new Set<string>();
  private consumed = new Set<string>();
  private deliveryIds = new Set<string>();

  constructor(
    private readonly wire: NativeVoiceWire,
    private readonly expectedProfile: NativeVoiceProfile = 'offline-memory-v1',
  ) {
    this.unsubscribe = wire.subscribe(
      (value) => {
        if (this.terminal) {
          // Drain already-buffered valid events without dispatch or settlement.
          // Only the matching close ack can finish this bounded stop transaction.
          if (this.closeId) {
            try {
              this.drain(decode(value, this.expectedProfile));
            } catch {
              this.closed.reject(new VoiceError('VOICE_PROTOCOL_ERROR'));
            }
          }
          return;
        }
        try {
          this.message(decode(value, this.expectedProfile));
        } catch (error) {
          this.fail(error instanceof VoiceError ? error : new VoiceError('VOICE_PROTOCOL_ERROR'));
        }
      },
      (error) => {
        if (this.terminal) this.closed.reject(error);
        else this.fail(error);
      },
    );
    if (this.terminal) this.unsubscribe();
  }

  private drain(frame: FromHelper): void {
    switch (frame.type) {
      case 'delivery': {
        const context = this.closingAppends.get(frame.commandId);
        if (
          !context ||
          context.handoffId !== frame.handoffId ||
          context.deliveryId !== frame.deliveryId
        )
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.closingAppends.delete(frame.commandId);
        return; // The canceled append stays UNKNOWN, even for a valid late ack.
      }
      case 'hello':
        if (!this.helloId || this.startId || frame.commandId !== this.helloId)
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.helloId = 0;
        return;
      case 'answer':
        if (!this.startId || this.answered || frame.commandId !== this.startId)
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.answered = true;
        return;
      case 'control_ready':
        if (!this.answered || this.ready || frame.commandId !== this.startId)
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.ready = true;
        return;
      case 'handoff':
      case 'transcript':
        if (!this.ready) throw new VoiceError('VOICE_PROTOCOL_ERROR');
        return; // Never enqueue, project speech or admit tasks during stop.
      case 'closed':
        if (frame.commandId !== this.closeId) throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.closed.resolve();
        return;
      case 'error':
        if (
          frame.commandId !== undefined &&
          frame.commandId !== this.closeId &&
          frame.commandId !== this.helloId &&
          frame.commandId !== this.startId &&
          !this.closingAppends.has(frame.commandId)
        )
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.closed.reject(new VoiceError(frame.code));
    }
  }

  private command(): number {
    if (this.nextId >= 2_147_483_647) throw new VoiceError('VOICE_RATE_LIMITED');
    return ++this.nextId;
  }
  private deadline() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail(new VoiceError('VOICE_NEGOTIATION_TIMEOUT')),
      voiceLimits.startTimeoutMs,
    );
    this.timer.unref();
  }
  async start(
    offer: string,
    receive: (event: VoiceProviderEvent) => void,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.started || this.terminal) throw new VoiceError('VOICE_REQUEST_CONFLICT');
    if (!nativeText(offer, voiceLimits.maxSdpBytes)) throw new VoiceError('VOICE_PROTOCOL_ERROR');
    this.started = true;
    this.receive = receive;
    const abort = () => {
      if (this.answerAccepted) void this.stop().catch(() => {});
      else this.fail(new VoiceError('VOICE_NEGOTIATION_EXPIRED'));
    };
    signal.addEventListener('abort', abort, { once: true });
    this.removeAbort = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) {
      abort();
      throw new VoiceError('VOICE_NEGOTIATION_EXPIRED');
    }
    this.deadline();
    try {
      this.helloId = this.command();
      this.wire.send({ v: 1, type: 'hello', commandId: this.helloId });
      await this.hello.promise;
      if (this.terminal) throw new VoiceError('VOICE_PROVIDER_DISCONNECTED');
      this.startId = this.command();
      this.wire.send({ v: 1, type: 'start', commandId: this.startId, offer });
      return await this.answer.promise;
    } catch (error) {
      const safe = error instanceof VoiceError ? error : new VoiceError('VOICE_PROVIDER_ERROR');
      this.fail(safe);
      throw safe;
    }
  }

  private message(frame: FromHelper): void {
    switch (frame.type) {
      case 'error':
        if (
          frame.commandId !== undefined &&
          frame.commandId !== this.helloId &&
          !(frame.commandId === this.startId && !this.ready) &&
          !this.appends.has(frame.commandId)
        )
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.fail(new VoiceError(frame.code));
        return;
      case 'hello':
        if (!this.helloId || frame.commandId !== this.helloId || this.startId)
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.helloId = 0;
        this.hello.resolve();
        return;
      case 'answer':
        if (!this.startId || frame.commandId !== this.startId || this.answered)
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.answered = true;
        this.deadline(); // Separate readiness deadline: do not hold the answer.
        this.answer.resolve(frame.sdp);
        return;
      case 'control_ready':
        if (!this.answered || this.ready || frame.commandId !== this.startId)
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.ready = true;
        clearTimeout(this.timer);
        if (this.expectedProfile === 'subscription-webrtc-v3') {
          try {
            console.info('NUAAI native voice control ready');
          } catch {
            /* Observability must not alter transport state. */
          }
        }
        return;
      case 'handoff':
        if (!this.ready || (!this.handoffs.has(frame.handoffId) && this.handoffs.size >= 48))
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.handoffs.add(frame.handoffId);
        this.forward({ type: 'handoff', handoffId: frame.handoffId, text: frame.text });
        return;
      case 'transcript':
        if (!this.ready) throw new VoiceError('VOICE_PROTOCOL_ERROR');
        this.forward({
          type: 'transcript',
          itemId: frame.itemId,
          role: frame.role,
          text: frame.text,
          final: frame.status === 'final',
        });
        return;
      case 'delivery': {
        const pending = this.appends.get(frame.commandId);
        if (
          !pending ||
          pending.context.handoffId !== frame.handoffId ||
          pending.context.deliveryId !== frame.deliveryId
        )
          throw new VoiceError('VOICE_PROTOCOL_ERROR');
        clearTimeout(pending.timer);
        this.appends.delete(frame.commandId);
        if (frame.status === 'unknown')
          pending.result.reject(new VoiceError('VOICE_DELIVERY_UNKNOWN'));
        else pending.result.resolve();
        return;
      }
      case 'closed':
        throw new VoiceError('VOICE_PROVIDER_DISCONNECTED');
    }
  }

  private forward(event: ReadyEvent): void {
    if (this.answerAccepted) {
      this.receive(event);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (
      this.queuedEvents.length >= voiceLimits.maxEvents ||
      this.queuedBytes + bytes > voiceLimits.maxEventBytes
    )
      throw new VoiceError('VOICE_PROTOCOL_ERROR');
    this.queuedBytes += bytes;
    this.queuedEvents.push(event);
  }

  acceptAnswer(): void {
    if (this.terminal) return;
    if (!this.answered) throw new VoiceError('VOICE_PROTOCOL_ERROR');
    this.answerAccepted = true;
    this.queuedBytes = 0;
    for (const event of this.queuedEvents.splice(0)) {
      if (this.terminal) break;
      this.receive(event);
    }
  }

  async deliver(text: string, context: VoiceDeliveryContext): Promise<void> {
    if (this.terminal) throw new VoiceError('VOICE_PROVIDER_DISCONNECTED');
    if (
      !this.ready ||
      !nativeText(text, voiceLimits.maxTranscriptBytes) ||
      !nativeText(context?.handoffId, 256) ||
      !nativeText(context?.deliveryId, 256) ||
      !this.handoffs.has(context.handoffId)
    )
      throw new VoiceError('VOICE_PROTOCOL_ERROR');
    if (this.consumed.has(context.handoffId) || this.deliveryIds.has(context.deliveryId))
      throw new VoiceError('VOICE_REQUEST_CONFLICT');
    if (this.appends.size >= 16) throw new VoiceError('VOICE_RATE_LIMITED');
    const commandId = this.command();
    const result = deferred<void>();
    const timer = setTimeout(
      () => this.fail(new VoiceError('VOICE_DELIVERY_UNKNOWN')),
      voiceLimits.startTimeoutMs,
    );
    timer.unref();
    this.consumed.add(context.handoffId);
    this.deliveryIds.add(context.deliveryId);
    this.appends.set(commandId, { context: { ...context }, result, timer });
    try {
      this.wire.send({
        v: 1,
        type: 'append',
        commandId,
        handoffId: context.handoffId,
        deliveryId: context.deliveryId,
        text,
      });
    } catch {
      this.fail(new VoiceError('VOICE_DELIVERY_UNKNOWN'));
    }
    return result.promise;
  }
  async interrupt(): Promise<void> {
    throw new VoiceError('VOICE_INTERRUPTION_UNSUPPORTED');
  }

  private cancel(error: VoiceError) {
    this.queuedEvents.length = 0;
    this.queuedBytes = 0;
    clearTimeout(this.timer);
    this.removeAbort();
    this.hello.reject(error);
    this.answer.reject(error);
    for (const pending of this.appends.values()) {
      clearTimeout(pending.timer);
      pending.result.reject(new VoiceError('VOICE_DELIVERY_UNKNOWN'));
    }
    this.appends.clear();
  }
  private fail(error: VoiceError) {
    if (this.terminal) return;
    this.terminal = true;
    this.cancel(error);
    this.termination = this.cleanup();
    void this.termination.catch(() => {});
    this.receive({ type: 'error', error });
  }
  private async bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new VoiceError('VOICE_CLEANUP_FAILED')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async cleanup(): Promise<void> {
    try {
      await this.bounded(this.wire.close(), 1_500);
    } finally {
      this.closingAppends.clear();
      this.unsubscribe();
    }
  }
  stop(): Promise<void> {
    if (this.termination) return this.termination;
    this.terminal = true;
    for (const [commandId, pending] of this.appends)
      this.closingAppends.set(commandId, pending.context);
    this.cancel(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
    this.termination = (async () => {
      try {
        if (this.started) {
          this.closeId = this.command();
          this.wire.send({ v: 1, type: 'close', commandId: this.closeId });
          await this.bounded(this.closed.promise, 500);
        }
      } finally {
        await this.cleanup();
      }
    })();
    void this.termination.catch(() => {});
    return this.termination;
  }
}
