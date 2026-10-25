import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeVoiceDiagnostics } from '../src/voice/native-diagnostics.js';
import { composeNativeVoiceChild, nativeHelperEnvironment } from '../src/voice/native-provider.js';
import { createNativeChildWire } from '../src/voice/native-wire.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function memoryChild() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const records = vi.fn();
  const parser = new NativeVoiceDiagnostics(records);
  stderr.on('data', (bytes: Buffer) => parser.write(bytes));
  stderr.on('end', () => parser.end());
  const bridge = composeNativeVoiceChild(child, stdin, stdout, stderr, { warn: vi.fn() });
  const wire = createNativeChildWire(bridge);
  const exit = () => {
    child.exitCode = 1;
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
  };
  return { child, stdin, stdout, stderr, records, bridge, wire, exit };
}
describe('native child independent stdio drain', () => {
  it('preserves a queued safe diagnostic when stdout EOF and exit precede stderr EOF', async () => {
    const f = memoryChild();
    f.stderr.pause();
    f.stderr.end('NUAAI_VOICE_DIAGNOSTIC operation=call kind=http status=403\n');
    f.stdout.end();
    await tick();
    f.exit();
    let closed = false;
    const closing = f.wire.close().then(() => {
      closed = true;
    });
    await tick();
    try {
      expect(closed).toBe(false);
      expect(f.stderr.destroyed).toBe(false);
    } finally {
      f.stderr.resume();
      await closing;
    }
    expect(f.records).toHaveBeenCalledExactlyOnceWith({
      operation: 'call',
      kind: 'http',
      status: 403,
    });
  });
  it('still waits for stdout after stderr EOF and process exit', async () => {
    const f = memoryChild();
    f.stderr.end();
    await tick();
    f.exit();
    let closed = false;
    const closing = f.wire.close().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    f.stdout.end();
    await closing;
    expect(f.bridge.exitCode).toBe(1);
  });
  it('keeps cleanup bounded when an exited child never supplies stderr EOF', async () => {
    vi.useFakeTimers();
    const f = memoryChild();
    f.stdout.end();
    await vi.advanceTimersByTimeAsync(0);
    f.exit();
    const closing = expect(f.wire.close()).rejects.toMatchObject({ code: 'VOICE_CLEANUP_FAILED' });
    await vi.advanceTimersByTimeAsync(1500);
    await closing;
    expect(f.stderr.destroyed).toBe(true);
  });
});
describe('native helper trusted environment', () => {
  it('preserves only trusted HOME/CODEX_HOME and fixed basic process settings', () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-no-inheritance');
    vi.stubEnv('HTTPS_PROXY', 'synthetic-no-inheritance');
    vi.stubEnv('NODE_OPTIONS', 'synthetic-no-inheritance');
    vi.stubEnv('CODEX_HOME', '/fixture/codex');
    const env = nativeHelperEnvironment({ home: '/fixture/home' });
    expect(env).toEqual({
      HOME: '/fixture/home',
      CODEX_HOME: '/fixture/codex',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
    });
    expect(JSON.stringify(env)).not.toContain('synthetic-no-inheritance');
  });
  it('uses explicit trusted host settings and rejects relative or malformed homes', () => {
    expect(
      nativeHelperEnvironment({ home: '/fixture/home', codexHome: '/fixture/managed' }).CODEX_HOME,
    ).toBe('/fixture/managed');
    expect(() => nativeHelperEnvironment({ home: 'relative' })).toThrow(/VOICE_CODEX_UNAVAILABLE/);
    expect(() => nativeHelperEnvironment({ home: '/fixture/home', codexHome: 'relative' })).toThrow(
      /VOICE_CODEX_UNAVAILABLE/,
    );
    expect(() => nativeHelperEnvironment({ home: '/fixture/\0' })).toThrow(
      /VOICE_CODEX_UNAVAILABLE/,
    );
  });
});
