import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { VoiceError, type VoiceProvider } from './broker.js';
import { unsupportedCodexVoiceProvider } from './codex-transport.js';
import { NativeVoiceTransport } from './native-transport.js';
import {
  type NativeVoiceChild,
  type NativeVoiceWire,
  createNativeChildWire,
} from './native-wire.js';

export interface NativeVoiceHostOptions {
  /** Trusted host setup only, never HTTP/browser input. */
  home?: string;
  codexHome?: string;
  temporaryRoot?: string;
}

export function nativeHelperEnvironment(options: NativeVoiceHostOptions = {}): NodeJS.ProcessEnv {
  const home = options.home ?? process.env.HOME ?? homedir();
  const codexHome = options.codexHome ?? process.env.CODEX_HOME;
  if (
    !isAbsolute(home) ||
    home.includes('\0') ||
    (codexHome && (!isAbsolute(codexHome) || codexHome.includes('\0')))
  )
    throw new VoiceError('VOICE_CODEX_UNAVAILABLE', 503, 'preflight');
  return {
    HOME: home,
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
  };
}

/** Pin the validated inode for exec through inherited FD3. Never read its bytes. */
function executable(path: string): number {
  let fd: number | undefined;
  try {
    if (process.platform !== 'linux' || !isAbsolute(path) || realpathSync(path) !== path)
      throw new Error('untrusted executable');
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o022) !== 0 ||
      (metadata.mode & 0o100) === 0
    )
      throw new Error('untrusted executable');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const pinned = fstatSync(fd);
    if (
      pinned.dev !== metadata.dev ||
      pinned.ino !== metadata.ino ||
      pinned.uid !== metadata.uid ||
      pinned.mode !== metadata.mode
    )
      throw new Error('executable changed');
    return fd;
  } catch {
    if (fd !== undefined) closeSync(fd);
    throw new VoiceError('VOICE_CODEX_UNAVAILABLE', 503, 'preflight');
  }
}

/** FIFO handles use libuv's existing-FD pipe support, not new Socket pairs.
 * Each descriptor is separately opened, so making the parent nonblocking cannot
 * change the child's blocking FIFO file description. No thread-pool read stalls.
 */
function fifoStream(fd: number, readable: boolean): Socket {
  return new Socket({ fd, readable, writable: !readable, allowHalfOpen: false });
}

function composeChild(
  child: ChildProcess,
  stdin: Socket,
  stdout: Socket,
  stderr: Socket,
): NativeVoiceChild {
  const bridge = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: (signal?: NodeJS.Signals | number) =>
      child.exitCode === null && child.signalCode === null && child.kill(signal),
  });
  let exited = child.exitCode !== null || child.signalCode !== null;
  let drained = false;
  let closed = false;
  const finish = () => {
    if (!exited || !drained || closed) return;
    closed = true;
    bridge.exitCode = child.exitCode;
    bridge.signalCode = child.signalCode;
    bridge.emit('exit', child.exitCode, child.signalCode);
    bridge.emit('close', child.exitCode, child.signalCode);
  };
  stdout.on('end', () => {
    drained = true;
    finish();
  });
  child.on('exit', () => {
    exited = true;
    finish();
  });
  child.on('close', () => {
    exited = true;
    finish();
  });
  child.on('error', () => bridge.emit('error', new VoiceError('VOICE_PROVIDER_DISCONNECTED')));
  return bridge;
}

function openWire(path: string, options: NativeVoiceHostOptions): NativeVoiceWire {
  const environment = nativeHelperEnvironment(options);
  const execFd = executable(path);
  const descriptors = new Set<number>([execFd]);
  const streams: Socket[] = [];
  let directory: string | undefined;
  let child: ChildProcess | undefined;
  const closeFd = (fd: number) => {
    closeSync(fd);
    descriptors.delete(fd);
  };
  const open = (path: string, flags: number) => {
    const fd = openSync(path, flags | constants.O_NOFOLLOW);
    descriptors.add(fd);
    const metadata = fstatSync(fd);
    if (
      !metadata.isFIFO() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o600
    )
      throw new VoiceError('VOICE_CODEX_UNAVAILABLE', 503, 'preflight');
    return fd;
  };
  try {
    directory = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), 'nuaai-voice-'));
    chmodSync(directory, 0o700);
    const paths = ['stdin', 'stdout', 'stderr'].map((name) => join(directory as string, name));
    execFileSync('/usr/bin/mkfifo', ['--mode=600', '--', ...paths], {
      env: { PATH: '/usr/bin:/bin' },
      stdio: 'ignore',
      timeout: 2000,
    });
    const holders = paths.map((file) => open(file, constants.O_RDWR | constants.O_NONBLOCK));
    const input = open(paths[0], constants.O_RDONLY);
    const output = open(paths[1], constants.O_WRONLY);
    const error = open(paths[2], constants.O_WRONLY);
    const writer = open(paths[0], constants.O_WRONLY);
    const reader = open(paths[1], constants.O_RDONLY);
    const errorReader = open(paths[2], constants.O_RDONLY);
    const stdin = fifoStream(writer, false);
    descriptors.delete(writer);
    streams.push(stdin);
    const stdout = fifoStream(reader, true);
    descriptors.delete(reader);
    streams.push(stdout);
    const stderr = fifoStream(errorReader, true);
    descriptors.delete(errorReader);
    streams.push(stderr);
    // Execute the pinned file description, not a path that could be swapped after
    // validation. The native entry closes FD3+ before starting its runtime.
    child = spawn('/proc/self/fd/3', [], {
      shell: false,
      cwd: directory,
      env: environment,
      stdio: [input, output, error, execFd],
    });
    for (const fd of [input, output, error, execFd, ...holders]) closeFd(fd);
    const base = createNativeChildWire(composeChild(child, stdin, stdout, stderr));
    const ownedDirectory = directory;
    const ownedChild = child;
    let closing: Promise<void> | undefined;
    return {
      send: (frame) => base.send(frame),
      subscribe: (receive, failed) => base.subscribe(receive, failed),
      close: () => {
        closing ??= (async () => {
          let stopped = false;
          try {
            await base.close();
          } finally {
            const exited = () => ownedChild.exitCode !== null || ownedChild.signalCode !== null;
            if (!exited()) {
              ownedChild.kill('SIGKILL');
              await new Promise<void>((resolve) => {
                const done = () => {
                  clearTimeout(timer);
                  ownedChild.off('exit', done);
                  ownedChild.off('close', done);
                  resolve();
                };
                const timer = setTimeout(done, 200);
                ownedChild.once('exit', done);
                ownedChild.once('close', done);
              });
            }
            for (const stream of streams) stream.destroy();
            rmSync(ownedDirectory, { recursive: true, force: true });
            stopped = exited();
          }
          if (!stopped) throw new VoiceError('VOICE_CLEANUP_FAILED', 502, 'stop');
        })();
        return closing;
      },
    };
  } catch {
    child?.kill('SIGKILL');
    for (const stream of streams) stream.destroy();
    for (const fd of descriptors) closeSync(fd);
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw new VoiceError('VOICE_CODEX_UNAVAILABLE', 503, 'preflight');
  }
}

/** Trusted operator opt-in. Neither a browser field nor daemon provider RPC. */
export function createNativeVoiceProvider(
  path: string | undefined,
  options: NativeVoiceHostOptions = {},
): VoiceProvider {
  if (!path) return unsupportedCodexVoiceProvider;
  const validate = () => {
    const fd = executable(path);
    closeSync(fd);
    nativeHelperEnvironment(options);
  };
  return {
    availability: () => {
      try {
        validate();
        return { available: true, taskMode: 'daemon', interruption: 'unsupported' };
      } catch {
        return {
          available: false,
          taskMode: 'disabled',
          interruption: 'unsupported',
          blocker: 'VOICE_CODEX_UNAVAILABLE',
        };
      }
    },
    create: () => new NativeVoiceTransport(openWire(path, options), 'subscription-webrtc-v3'),
  };
}
