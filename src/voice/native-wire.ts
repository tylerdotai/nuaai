import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { VoiceError } from './broker.js';
import type { ToHelper } from './native-transport.js';
import { voiceLimits } from './types.js';

/** Host-owned streams may be ordinary Node fixture pipes or reviewed FIFO FDs.
 * This adapter neither selects descriptors nor asserts native auth-FD approval.
 */
export type NativeVoiceChild = Pick<
  ChildProcess,
  'on' | 'off' | 'kill' | 'exitCode' | 'signalCode'
> & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
};

export interface NativeVoiceWire {
  send(frame: ToHelper): void;
  subscribe(receive: (frame: unknown) => void, failed: (error: VoiceError) => void): () => void;
  close(): Promise<void>;
}

export function nativeText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= max &&
    Buffer.from(value).toString('utf8') === value
  );
}

/** Flat JSON only: the frozen private union contains no arrays or nested objects.
 * Parsing before constructing an object preserves duplicate-key detection.
 */
function parseObject(source: string): Record<string, unknown> {
  let at = 0;
  const out: Record<string, unknown> = Object.create(null);
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(source[at] ?? '\0')) at++;
  };
  const token =
    /"(?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (): string | number => {
    whitespace();
    token.lastIndex = at;
    const match = token.exec(source);
    if (!match) throw new VoiceError('VOICE_PROTOCOL_ERROR');
    at = token.lastIndex;
    const parsed: unknown = JSON.parse(match[0]);
    if (
      (typeof parsed !== 'string' && typeof parsed !== 'number') ||
      (typeof parsed === 'number' && !Number.isFinite(parsed)) ||
      (typeof parsed === 'string' && Buffer.from(parsed).toString('utf8') !== parsed)
    )
      throw new VoiceError('VOICE_PROTOCOL_ERROR');
    return parsed;
  };
  whitespace();
  if (source[at++] !== '{') throw new VoiceError('VOICE_PROTOCOL_ERROR');
  whitespace();
  if (source[at] !== '}') {
    for (;;) {
      const key = value();
      if (typeof key !== 'string' || Object.hasOwn(out, key))
        throw new VoiceError('VOICE_PROTOCOL_ERROR');
      whitespace();
      if (source[at++] !== ':') throw new VoiceError('VOICE_PROTOCOL_ERROR');
      out[key] = value();
      whitespace();
      if (source[at] !== ',') break;
      at++;
    }
  }
  if (source[at++] !== '}') throw new VoiceError('VOICE_PROTOCOL_ERROR');
  whitespace();
  if (at !== source.length) throw new VoiceError('VOICE_PROTOCOL_ERROR');
  return out;
}

/** Incremental, bounded u32BE decoder; UTF-8 is checked only after full framing. */
export class NativeFrameDecoder {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private payload?: Buffer;
  private payloadBytes = 0;
  private failed = false;

  push(chunk: Buffer, receive: (frame: unknown) => void): void {
    if (this.failed) throw new VoiceError('VOICE_PROTOCOL_ERROR');
    try {
      let at = 0;
      while (at < chunk.length) {
        if (!this.payload) {
          const count = Math.min(4 - this.headerBytes, chunk.length - at);
          chunk.copy(this.header, this.headerBytes, at, at + count);
          this.headerBytes += count;
          at += count;
          if (this.headerBytes < 4) continue;
          const length = this.header.readUInt32BE();
          if (length < 1 || length > voiceLimits.maxBodyBytes)
            throw new VoiceError('VOICE_PAYLOAD_TOO_LARGE');
          this.payload = Buffer.alloc(length);
        }
        const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - at);
        chunk.copy(this.payload, this.payloadBytes, at, at + count);
        this.payloadBytes += count;
        at += count;
        if (this.payloadBytes !== this.payload.length) continue;
        const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          this.payload,
        );
        this.payload = undefined;
        this.payloadBytes = 0;
        this.headerBytes = 0;
        receive(parseObject(body));
      }
    } catch (error) {
      this.failed = true;
      throw error instanceof VoiceError ? error : new VoiceError('VOICE_PROTOCOL_ERROR');
    }
  }

  end(): void {
    if (this.failed || this.headerBytes !== 0 || this.payload)
      throw new VoiceError('VOICE_PROTOCOL_ERROR');
  }
}

export function encodeNativeFrame(frame: Record<string, unknown>): Buffer {
  const json = JSON.stringify(frame);
  parseObject(json);
  const body = Buffer.from(json);
  if (body.length < 1 || body.length > voiceLimits.maxBodyBytes)
    throw new VoiceError('VOICE_PAYLOAD_TOO_LARGE');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** Owns only an already-created, host-injected child. No executable selection,
 * auth paths, inherited environment, provider setup, or production activation.
 */
export function createNativeChildWire(child: NativeVoiceChild): NativeVoiceWire {
  const decoder = new NativeFrameDecoder();
  let listener: ((value: unknown) => void) | undefined;
  let onFailure: ((error: VoiceError) => void) | undefined;
  let failure: VoiceError | undefined;
  let closing: Promise<void> | undefined;
  const buffered: unknown[] = [];
  const fail = (error: VoiceError) => {
    if (failure) return;
    failure = error;
    onFailure?.(error);
  };
  child.stderr.resume(); // Never forward helper diagnostics or raw error messages.
  child.on('error', () => fail(new VoiceError('VOICE_PROVIDER_DISCONNECTED')));
  child.stdin.on('error', () => fail(new VoiceError('VOICE_PROVIDER_DISCONNECTED')));
  child.stdout.on('error', () => fail(new VoiceError('VOICE_PROVIDER_DISCONNECTED')));
  child.stdout.on('data', (chunk: Buffer) => {
    if (failure) return;
    try {
      decoder.push(chunk, (frame) => {
        if (listener) listener(frame);
        else {
          if (buffered.length >= 16) throw new VoiceError('VOICE_RATE_LIMITED');
          buffered.push(frame);
        }
      });
    } catch (error) {
      fail(error instanceof VoiceError ? error : new VoiceError('VOICE_PROTOCOL_ERROR'));
    }
  });
  child.stdout.on('end', () => {
    try {
      decoder.end();
      fail(new VoiceError('VOICE_PROVIDER_DISCONNECTED'));
    } catch {
      fail(new VoiceError('VOICE_PROTOCOL_ERROR'));
    }
  });
  child.on('close', () => fail(new VoiceError('VOICE_PROVIDER_DISCONNECTED')));
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (exited()) return resolve();
      const finish = () => {
        clearTimeout(timer);
        child.off('exit', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      child.on('exit', finish);
    });
  return {
    send: (frame) => {
      if (failure || closing) throw new VoiceError('VOICE_PROVIDER_DISCONNECTED');
      const bytes = encodeNativeFrame(frame);
      if (child.stdin.writableLength + bytes.length > voiceLimits.maxBodyBytes * 2)
        throw new VoiceError('VOICE_RATE_LIMITED');
      child.stdin.write(bytes);
    },
    subscribe: (receive, failed) => {
      if (listener) throw new VoiceError('VOICE_BUSY');
      listener = receive;
      onFailure = failed;
      for (const frame of buffered.splice(0)) receive(frame);
      if (failure) failed(failure);
      return () => {
        listener = undefined;
        onFailure = undefined;
      };
    },
    close: () => {
      closing ??= (async () => {
        child.stdin.end();
        await wait(400);
        if (!exited()) child.kill('SIGTERM');
        await wait(400);
        if (!exited()) child.kill('SIGKILL');
        await wait(400);
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        if (!exited()) throw new VoiceError('VOICE_CLEANUP_FAILED');
      })();
      return closing;
    },
  };
}
