import { describe, expect, it, vi } from 'vitest';
import { NativeVoiceDiagnostics, nativeVoiceExit } from '../src/voice/native-diagnostics.js';

const line = 'NUAAI_VOICE_DIAGNOSTIC operation=call kind=http status=403\n';
describe('private native voice safe diagnostics', () => {
  it('accepts exact complete whitelist lines split at every byte boundary', () => {
    for (let split = 0; split <= line.length; split++) {
      const emit = vi.fn();
      const parser = new NativeVoiceDiagnostics(emit);
      parser.write(Buffer.from(line.slice(0, split)));
      parser.write(Buffer.from(line.slice(split)));
      parser.end();
      expect(emit).toHaveBeenCalledExactlyOnceWith({
        operation: 'call',
        kind: 'http',
        status: 403,
      });
    }
  });
  it('accepts only fixed enums and allowed status values', () => {
    for (const operation of ['call', 'sideband'])
      for (const kind of [
        'api',
        'http',
        'timeout',
        'build',
        'transport',
        'stream',
        'invalid_request',
        'other',
      ])
        for (const status of [0, 100, 401, 599]) {
          const emit = vi.fn();
          const parser = new NativeVoiceDiagnostics(emit);
          parser.write(
            Buffer.from(
              `NUAAI_VOICE_DIAGNOSTIC operation=${operation} kind=${kind} status=${status}\n`,
            ),
          );
          expect(emit).toHaveBeenCalledExactlyOnceWith({ operation, kind, status });
        }
  });
  it.each([
    line.trim(),
    `${line.trim()} token=synthetic-private\n`,
    `synthetic-private ${line}`,
    line.replace('call', 'synthetic-private'),
    line.replace('http', 'synthetic-private'),
    ...['-1', '99', '600', '0403', 'NaN', 'Infinity', '403.0', '1e2', 'synthetic-private'].map(
      (status) => line.replace('403', status),
    ),
    line.replace(' status', '\0 status'),
    line.replace('\n', '\r\n'),
    ` ${line}`,
    '{"message":"synthetic-private"}\n',
  ])('discards unapproved stderr without forwarding any source text %j', (value) => {
    const emit = vi.fn();
    const parser = new NativeVoiceDiagnostics(emit);
    parser.write(Buffer.from(value));
    parser.end();
    expect(emit).not.toHaveBeenCalled();
  });
  it('drops oversized lines through the delimiter, including embedded valid-looking suffixes', () => {
    const emit = vi.fn();
    const parser = new NativeVoiceDiagnostics(emit);
    for (let i = 0; i < 100; i++) parser.write(Buffer.alloc(32768, 120));
    parser.write(Buffer.from(line));
    expect(emit).not.toHaveBeenCalled();
    parser.write(Buffer.from(line));
    expect(emit).toHaveBeenCalledExactlyOnceWith({ operation: 'call', kind: 'http', status: 403 });
  });
  it('rejects invalid UTF8/high-bit disguises and limits repeated safe records', () => {
    const emit = vi.fn();
    const parser = new NativeVoiceDiagnostics(emit);
    const invalid = Buffer.from(line);
    invalid[0] |= 0x80;
    parser.write(invalid);
    expect(emit).not.toHaveBeenCalled();
    parser.write(Buffer.from(line.repeat(100)));
    expect(emit).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(emit.mock.calls)).not.toContain('NUAAI_VOICE_DIAGNOSTIC');
  });
  it('discards a partial final line and ignores all bytes after end', () => {
    const emit = vi.fn();
    const parser = new NativeVoiceDiagnostics(emit);
    parser.write(Buffer.from(line.slice(0, -1)));
    parser.end();
    parser.write(Buffer.from(`\n${line}`));
    expect(emit).not.toHaveBeenCalled();
  });
  it('classifies only nonzero owned exit codes or explicitly allowed signals', () => {
    expect(nativeVoiceExit(1, null)).toEqual({ code: 1, signal: null });
    expect(nativeVoiceExit(101, null)).toEqual({ code: 101, signal: null });
    expect(nativeVoiceExit(null, 'SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });
    expect(nativeVoiceExit(null, 'SIGTERM')).toEqual({ code: null, signal: 'SIGTERM' });
    for (const code of [
      0,
      -2,
      256,
      1.1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '101',
      'synthetic-private',
      null,
      undefined,
    ])
      expect(nativeVoiceExit(code, null)).toBeUndefined();
    for (const signal of ['synthetic-private', 'SIGKILL token=private', {}, 9, undefined])
      expect(nativeVoiceExit(null, signal)).toBeUndefined();
    expect(nativeVoiceExit(101, 'SIGKILL')).toBeUndefined();
  });
  it('a failed logger cannot interrupt helper cleanup or retry raw input', () => {
    const emit = vi.fn(() => {
      throw new Error('sink unavailable');
    });
    const parser = new NativeVoiceDiagnostics(emit);
    expect(() => parser.write(Buffer.from(line.repeat(20)))).not.toThrow();
    expect(emit).toHaveBeenCalledTimes(8);
  });
});
