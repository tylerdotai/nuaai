import { spawn } from 'node:child_process';
import { sanitizedSubprocessEnvironment } from '../security/environment.js';
import {
  type VoiceDeliveryContext,
  VoiceError,
  type VoiceProvider,
  type VoiceProviderEvent,
  type VoiceTransport,
} from './broker.js';
import { voiceLimits } from './types.js';

/** No runtime option can turn unproven execution isolation into an attestation. */
export const unsupportedCodexVoiceProvider: VoiceProvider = {
  availability: () => ({
    available: false,
    taskMode: 'disabled',
    interruption: 'unsupported',
    blocker: 'VOICE_EXECUTION_ISOLATION_UNVERIFIED',
  }),
  create: () => {
    throw new VoiceError('VOICE_EXECUTION_ISOLATION_UNVERIFIED', 503, 'preflight');
  },
};
export interface VoiceRpcWire {
  send(message: unknown): void;
  subscribe(receive: (message: unknown) => void, failed: (error: VoiceError) => void): () => void;
  close(): Promise<void>;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown, max = voiceLimits.maxTranscriptBytes): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max;

/** Protocol implementation for injected, independently isolated hosts only.
 * NOT wired to installed Codex: rust-v0.164.0 stdio cannot supply empty ToolPolicy.
 * A transport tripwire detects violations; it is not proof of prevention.
 */
export class CodexVoiceTransport implements VoiceTransport {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: VoiceError): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly unsubscribe: () => void;
  private threadId?: string;
  private receive: (event: VoiceProviderEvent) => void = () => {};
  private stopped = false;
  private stopping?: Promise<void>;
  private startup?: {
    resolve(answer: string): void;
    reject(error: VoiceError): void;
    answer?: string;
    started: boolean;
  };
  constructor(private readonly wire: VoiceRpcWire) {
    this.unsubscribe = wire.subscribe(
      (value) => this.message(value),
      (error) => this.fail(error),
    );
  }
  private rpc(method: string, params: unknown, timeoutMs = 2_000): Promise<unknown> {
    if (this.stopped || (this.stopping && method !== 'thread/realtime/stop'))
      return Promise.reject(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
    if (this.pending.size >= 16) return Promise.reject(new VoiceError('VOICE_RATE_LIMITED'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VoiceError('VOICE_NEGOTIATION_TIMEOUT', 504, 'signaling'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.wire.send({ id, method, params });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
      }
    });
  }
  private fail(error: VoiceError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.startup?.reject(error);
    this.receive({ type: 'error', error });
  }
  private message(value: unknown): void {
    const message = record(value);
    if (!message) {
      this.fail(new VoiceError('VOICE_PROTOCOL_ERROR'));
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      this.wire.send({
        id: message.id,
        error: { code: -32601, message: 'Voice host denies executable server requests' },
      });
      this.receive({ type: 'execution' });
      return;
    }
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        const error = record(message.error);
        entry.reject(
          new VoiceError(
            error?.code === -32601 || error?.code === -32602
              ? 'VOICE_UNSUPPORTED_VERSION'
              : 'VOICE_PROVIDER_ERROR',
          ),
        );
      } else if ('result' in message) entry.resolve(message.result);
      else entry.reject(new VoiceError('VOICE_PROTOCOL_ERROR'));
      return;
    }
    const method = message.method;
    if (typeof method !== 'string') {
      this.fail(new VoiceError('VOICE_PROTOCOL_ERROR'));
      return;
    }
    const params = record(message.params);
    if (!params) return;
    if (params.threadId !== undefined && params.threadId !== this.threadId) {
      this.fail(new VoiceError('VOICE_PROTOCOL_ERROR'));
      return;
    }
    if (method === 'turn/started' || method === 'item/started' || method.startsWith('hook/')) {
      this.receive({ type: 'execution' });
      return;
    }
    if (!method.startsWith('thread/realtime/')) return;
    if (params.threadId !== this.threadId || !this.threadId) {
      this.fail(new VoiceError('VOICE_PROTOCOL_ERROR'));
      return;
    }
    if (method === 'thread/realtime/started') {
      if (params.version !== 'v3') {
        this.fail(new VoiceError('VOICE_UNSUPPORTED_VERSION'));
        return;
      }
      if (this.startup) this.startup.started = true;
    } else if (method === 'thread/realtime/sdp') {
      if (!text(params.sdp, voiceLimits.maxSdpBytes)) {
        this.fail(new VoiceError('VOICE_PROTOCOL_ERROR'));
        return;
      }
      if (this.startup) this.startup.answer = params.sdp;
    } else if (method === 'thread/realtime/itemAdded') {
      const item = record(params.item);
      if (item?.type === 'handoff_request') {
        if (!text(item.handoff_id, 256) || !text(item.input_transcript)) {
          this.fail(new VoiceError('VOICE_PROTOCOL_ERROR'));
          return;
        }
        this.receive({ type: 'handoff', handoffId: item.handoff_id, text: item.input_transcript });
      }
    } else if (method === 'thread/realtime/item/completed') {
      const item = record(params.item);
      if (item?.type === 'transcriptSegment') {
        if (
          !text(item.id, 256) ||
          !text(item.text) ||
          !['user', 'assistant'].includes(String(item.role))
        ) {
          this.fail(new VoiceError('VOICE_PROTOCOL_ERROR'));
          return;
        }
        this.receive({
          type: 'transcript',
          itemId: item.id,
          role: item.role as 'user' | 'assistant',
          text: item.text,
          final: true,
        });
      }
    } else if (method === 'thread/realtime/error') {
      this.fail(new VoiceError('VOICE_PROVIDER_ERROR'));
    } else if (method === 'thread/realtime/closed' && !this.stopped && !this.stopping) {
      this.fail(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
    }
    if (this.startup?.started && this.startup.answer) this.startup.resolve(this.startup.answer);
  }
  async start(
    offer: string,
    receive: (event: VoiceProviderEvent) => void,
    signal: AbortSignal,
  ): Promise<string> {
    this.receive = receive;
    const abort = () => {
      this.fail(new VoiceError('VOICE_NEGOTIATION_EXPIRED', 409, 'signaling'));
      void this.stop();
    };
    if (signal.aborted) {
      await this.stop();
      throw new VoiceError('VOICE_NEGOTIATION_EXPIRED', 409);
    }
    signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(
      () => this.fail(new VoiceError('VOICE_NEGOTIATION_TIMEOUT', 504, 'signaling')),
      voiceLimits.startTimeoutMs,
    );
    deadline.unref();
    try {
      await this.rpc('initialize', {
        clientInfo: { name: 'nuaai-voice', version: '1' },
        capabilities: { experimentalApi: true },
      });
      this.wire.send({ method: 'initialized' });
      const account = record(await this.rpc('account/read', { refreshToken: false }));
      const auth = record(account?.account);
      if (!auth) throw new VoiceError('VOICE_CODEX_LOGIN_REQUIRED', 409, 'preflight');
      if (auth.type !== 'chatgpt')
        throw new VoiceError('VOICE_SUBSCRIPTION_REQUIRED', 403, 'preflight');
      const thread = record(
        record(
          await this.rpc('thread/start', {
            modelProvider: 'openai',
            ephemeral: true,
            sandbox: 'read-only',
            approvalPolicy: 'never',
            environments: [],
            dynamicTools: [],
            selectedCapabilityRoots: [],
          }),
        )?.thread,
      );
      if (!text(thread?.id, 256)) throw new VoiceError('VOICE_PROTOCOL_ERROR');
      this.threadId = thread.id;
      const answer = new Promise<string>((resolve, reject) => {
        this.startup = { resolve, reject, started: false };
      });
      // Attach rejection handling before start RPC: synchronous fixture notifications may reject it.
      const started = Promise.all([
        this.rpc('thread/realtime/start', {
          threadId: this.threadId,
          transport: { type: 'webrtc', sdp: offer },
          version: 'v3',
          outputModality: 'audio',
          voice: 'cove',
          clientManagedHandoffs: true,
          includeStartupContext: false,
          flushTranscriptTailOnSessionEnd: false,
        }),
        answer,
      ]);
      const [, sdp] = await started;
      this.startup = undefined;
      return sdp;
    } catch (error) {
      await this.stop();
      throw error instanceof VoiceError ? error : new VoiceError('VOICE_PROVIDER_ERROR');
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
    }
  }
  async deliver(content: string, context: VoiceDeliveryContext): Promise<void> {
    if (
      !text(content) ||
      !text(context?.handoffId, 256) ||
      !text(context?.deliveryId, 256) ||
      !this.threadId
    )
      throw new VoiceError('VOICE_PROTOCOL_ERROR');
    // Legacy injected-host append is session-scoped. Its RPC acceptance is NOT
    // per-delegation resolution; native helper delivery uses a separate adapter.
    await this.rpc('thread/realtime/appendSpeech', { threadId: this.threadId, text: content });
  }
  async interrupt(): Promise<void> {
    throw new VoiceError('VOICE_INTERRUPTION_UNSUPPORTED', 409);
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = Promise.resolve().then(async () => {
      try {
        if (this.threadId && !this.stopped)
          await this.rpc('thread/realtime/stop', { threadId: this.threadId });
      } finally {
        this.stopped = true;
        this.unsubscribe();
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
        }
        this.pending.clear();
        this.startup?.reject(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
        this.startup = undefined;
        await this.wire.close();
      }
    });
    return this.stopping;
  }
}

/** Bounded shell-free process wire. Not constructed by the unavailable installed provider. */
export function createCodexStdioWire(
  executable: string,
  cwd: string,
  codexHome: string,
): VoiceRpcWire {
  const child = spawn(
    executable,
    [
      'app-server',
      '--listen',
      'stdio://',
      '--enable',
      'realtime_conversation',
      '-c',
      'model_provider="openai"',
    ],
    {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizedSubprocessEnvironment({ CODEX_HOME: codexHome }),
    },
  );
  const listeners = new Set<(message: unknown) => void>();
  const failures = new Set<(error: VoiceError) => void>();
  let buffer = Buffer.alloc(0);
  let ended = false;
  let closing: Promise<void> | undefined;
  const fail = () => {
    for (const listener of failures) listener(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
  };
  child.stderr.resume(); // Never retain/forward provider stderr or raw protocol.
  child.on('error', fail);
  child.on('exit', () => {
    ended = true;
    fail();
  });
  child.on('close', () => {
    ended = true;
  });
  child.stdin.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.byteLength > 256 * 1_024) {
      for (const listener of failures) listener(new VoiceError('VOICE_PROTOCOL_ERROR'));
      child.kill('SIGTERM');
      buffer = Buffer.alloc(0);
      return;
    }
    let newline = buffer.indexOf(10);
    while (newline !== -1) {
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      try {
        const message: unknown = JSON.parse(line);
        for (const listener of listeners) listener(message);
      } catch {
        for (const listener of failures) listener(new VoiceError('VOICE_PROTOCOL_ERROR'));
      }
      newline = buffer.indexOf(10);
    }
  });
  const waitExit = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (ended) {
        resolve(true);
        return;
      }
      const done = () => {
        clearTimeout(timer);
        child.removeListener('exit', done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.removeListener('exit', done);
        resolve(false);
      }, ms);
      child.once('exit', done);
    });
  return {
    send(message) {
      if (ended || closing) throw new VoiceError('VOICE_PROVIDER_DISCONNECTED');
      const line = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(line) > 256 * 1_024 || child.stdin.writableLength > 256 * 1_024)
        throw new VoiceError('VOICE_PROTOCOL_ERROR');
      child.stdin.write(line);
    },
    subscribe(receive, failed) {
      listeners.add(receive);
      failures.add(failed);
      return () => {
        listeners.delete(receive);
        failures.delete(failed);
      };
    },
    close() {
      closing ??= (async () => {
        listeners.clear();
        failures.clear();
        buffer = Buffer.alloc(0);
        child.stdin.end();
        if (!ended) child.kill('SIGTERM');
        if (!(await waitExit(1_000))) {
          child.kill('SIGKILL');
          if (!(await waitExit(1_000))) throw new VoiceError('VOICE_CLEANUP_FAILED', 502, 'stop');
        }
      })();
      return closing;
    },
  };
}
