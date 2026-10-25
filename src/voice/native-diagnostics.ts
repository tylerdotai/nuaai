/** Private stderr metadata only. Never retain or log the original line. */
export interface NativeVoiceDiagnostic {
  readonly operation: 'call' | 'sideband';
  readonly kind:
    | 'api'
    | 'http'
    | 'timeout'
    | 'build'
    | 'transport'
    | 'stream'
    | 'invalid_request'
    | 'other';
  readonly status: number;
}

const signals = [
  'SIGTERM',
  'SIGKILL',
  'SIGABRT',
  'SIGSEGV',
  'SIGBUS',
  'SIGILL',
  'SIGFPE',
  'SIGPIPE',
  'SIGINT',
  'SIGHUP',
] as const;
export interface NativeVoiceExit {
  readonly code: number | null;
  readonly signal: (typeof signals)[number] | null;
}

export function nativeVoiceExit(code: unknown, signal: unknown): NativeVoiceExit | undefined {
  if (
    typeof code === 'number' &&
    Number.isInteger(code) &&
    code > 0 &&
    code <= 255 &&
    signal === null
  )
    return { code, signal: null };
  if (code === null && typeof signal === 'string' && signals.some((allowed) => allowed === signal))
    return { code: null, signal: signal as (typeof signals)[number] };
  return undefined;
}

const pattern =
  /^NUAAI_VOICE_DIAGNOSTIC operation=(call|sideband) kind=(api|http|timeout|build|transport|stream|invalid_request|other) status=(0|[1-5][0-9]{2})$/;
const maxLineBytes = 160;
const maxRecords = 8;

/** Complete LF-delimited ASCII records only; bounded across arbitrary chunks. */
export class NativeVoiceDiagnostics {
  private partial = Buffer.alloc(0);
  private dropping = false;
  private ended = false;
  private records = 0;

  constructor(private readonly emit: (diagnostic: NativeVoiceDiagnostic) => void) {}

  write(bytes: Buffer): void {
    if (this.ended || this.records >= maxRecords) return;
    let at = 0;
    while (at < bytes.length && this.records < maxRecords) {
      const newline = bytes.indexOf(10, at);
      const end = newline < 0 ? bytes.length : newline;
      if (!this.dropping) {
        if (this.partial.length + end - at > maxLineBytes) {
          this.partial = Buffer.alloc(0);
          this.dropping = true;
        } else this.partial = Buffer.concat([this.partial, bytes.subarray(at, end)]);
      }
      if (newline < 0) break;
      if (!this.dropping && this.partial.every((byte) => byte >= 32 && byte <= 126)) {
        const match = pattern.exec(this.partial.toString('ascii'));
        if (match) {
          this.records++;
          const diagnostic: NativeVoiceDiagnostic = {
            operation: match[1] as NativeVoiceDiagnostic['operation'],
            kind: match[2] as NativeVoiceDiagnostic['kind'],
            status: Number(match[3]),
          };
          try {
            this.emit(diagnostic);
          } catch {
            /* A diagnostic sink must not break voice cleanup. */
          }
        }
      }
      this.partial = Buffer.alloc(0);
      this.dropping = false;
      at = newline + 1;
    }
  }

  end(): void {
    this.ended = true;
    this.partial = Buffer.alloc(0);
  }
}
