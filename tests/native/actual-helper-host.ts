import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  constants,
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { hashFile, traceAttempts } from './run-synthetic-auth.mjs';

/** Manual offline fixture host only; never selects or installs a production provider. */
export type OwnedFifoChild = Pick<
  ChildProcess,
  'on' | 'off' | 'kill' | 'exitCode' | 'signalCode'
> & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
};
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Same unchanged denial argv used by the successful actual helper session.
 * No URL, method, backend, environment or protocol selector is accepted.
 */
export function offlineHelperTraceArgs(artifact: string, tracePath: string): string[] {
  return [
    '--kill-on-exit',
    '-f',
    '-qq',
    '-e',
    'trace=%network,io_uring_setup,io_uring_enter,io_uring_register,execve,execveat,close_range',
    '-e',
    'raw=all',
    '--inject=%network,io_uring_setup,io_uring_enter,io_uring_register:error=EPERM',
    '-o',
    tracePath,
    artifact,
  ];
}

/** Integer stdio does not belong to ChildProcess's pipe lifecycle. Compose close
 * after both process exit and the separately owned FIFO stdout's actual EOF.
 */
export function bindOwnedFifoChild(
  process: ChildProcess,
  stdin: Writable,
  stdout: Readable,
): { child: OwnedFifoChild; eof: () => boolean } {
  const host = new EventEmitter();
  let eof = false;
  let exited = process.exitCode !== null || process.signalCode !== null;
  let closed = false;
  const close = () => {
    if (exited && eof && !closed) {
      closed = true;
      host.emit('close', process.exitCode, process.signalCode);
    }
  };
  stdout.on('end', () => {
    eof = true;
    close();
  });
  process.on('exit', (...args) => {
    exited = true;
    host.emit('exit', ...args);
    close();
  });
  process.on('error', (error) => host.emit('error', error));
  Object.assign(host, {
    stdin,
    stdout,
    stderr: Readable.from([]),
    kill: (signal?: NodeJS.Signals | number) => process.kill(signal),
  });
  Object.defineProperties(host, {
    exitCode: { get: () => process.exitCode },
    signalCode: { get: () => process.signalCode },
  });
  return { child: host as unknown as OwnedFifoChild, eof: () => eof };
}

/** Caller MUST independently review/freeze the native source and explicit artifact
 * before calling this function. No Cargo, downloads, constructors or process at import.
 * outputDirectory must be NEW, with an existing owned/private parent directory.
 */
export async function openActualHelper(options: {
  binary: string;
  sha256: string;
  evidenceRoot: string;
}) {
  check(process.platform === 'linux' && process.arch === 'x64', 'Linux/x64 offline fixture only');
  check(/^[a-f0-9]{64}$/.test(options.sha256), 'Explicit approved ELF digest required');
  const artifact = resolve(options.binary);
  const verifyArtifact = () =>
    check(hashFile(artifact) === options.sha256, 'Offline helper ELF changed');
  verifyArtifact(); // Before directory, FIFO, mkfifo or native/tracer process.
  const output = resolve(options.evidenceRoot);
  mkdirSync(output, { mode: 0o700 }); // Never overwrite prior evidence.
  const inputPath = join(output, 'input.fifo');
  const outputPath = join(output, 'output.fifo');
  const tracePath = join(output, 'helper.strace');
  const stderrPath = join(output, 'helper.stderr');
  const descriptors = new Set<number>();
  const open = (path: string, flags: number, mode?: number) => {
    const fd = openSync(path, flags | constants.O_NOFOLLOW, mode);
    descriptors.add(fd);
    return fd;
  };
  const close = (fd: number) => {
    closeSync(fd);
    descriptors.delete(fd);
  };
  let owned: ChildProcess | undefined;
  let input: ReturnType<typeof createWriteStream> | undefined;
  let stdout: ReturnType<typeof createReadStream> | undefined;
  try {
    execFileSync('/usr/bin/mkfifo', ['-m', '600', inputPath, outputPath], { env: {} });
    const inputHolder = open(inputPath, constants.O_RDWR);
    const outputHolder = open(outputPath, constants.O_RDWR);
    const childIn = open(inputPath, constants.O_RDONLY);
    const writer = open(inputPath, constants.O_WRONLY);
    const childOut = open(outputPath, constants.O_WRONLY);
    const reader = open(outputPath, constants.O_RDONLY);
    const stderrFd = open(
      stderrPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    for (const fd of descriptors) {
      const stat = fstatSync(fd);
      check(
        stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600,
        'Offline descriptor owner/mode differs',
      );
      check(
        fd === stderrFd ? stat.isFile() : stat.isFIFO(),
        'Offline stdio must be FIFO/regular, never sockets',
      );
    }
    owned = spawn('/usr/bin/strace', offlineHelperTraceArgs(artifact, tracePath), {
      cwd: output,
      env: { PATH: '/usr/bin:/bin', HOME: output, TMPDIR: output },
      stdio: [childIn, childOut, stderrFd],
    });
    for (const fd of [childIn, childOut, stderrFd, inputHolder, outputHolder]) close(fd);
    input = createWriteStream(inputPath, { fd: writer, autoClose: true });
    descriptors.delete(writer);
    stdout = createReadStream(outputPath, { fd: reader, autoClose: true });
    descriptors.delete(reader);
    const bound = bindOwnedFifoChild(owned, input, stdout);
    const processExited = () => owned?.exitCode !== null || owned?.signalCode !== null;
    const waitExit = (ms: number) =>
      new Promise<void>((resolve) => {
        if (processExited()) return resolve();
        const done = () => {
          clearTimeout(timer);
          owned?.off('exit', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        owned?.on('exit', done);
      });
    return {
      host: bound.child,
      tracePath,
      stderrPath,
      verifyArtifact,
      /** Read only after normal transport stop. No frame bodies/SDP are captured. */
      finish: () => {
        verifyArtifact();
        check(
          owned?.exitCode === 0 && owned.signalCode === null && bound.eof(),
          'Offline process did not exit cleanly with EOF',
        );
        check(readFileSync(stderrPath, 'utf8') === '', 'Offline helper stderr was not empty');
        const trace = readFileSync(tracePath, 'utf8');
        check(
          traceAttempts(trace).length === 0 && !trace.includes('(INJECTED)'),
          'Offline native zero-network assertion failed',
        );
        check(trace.includes('close_range('), 'Offline native descriptor guard not observed');
        return {
          status: 0,
          eof: true,
          networkAttempts: 0,
          hashStable: true,
          descriptorGuardObserved: true,
        } as const;
      },
      /** Always call in runner finally; does not send protocol frames or retry. */
      close: async () => {
        if (!processExited()) {
          owned?.kill('SIGTERM');
          await waitExit(400);
        }
        if (!processExited()) {
          owned?.kill('SIGKILL');
          await waitExit(400);
        }
        input?.destroy();
        stdout?.destroy();
        rmSync(inputPath, { force: true });
        rmSync(outputPath, { force: true });
        check(processExited(), 'Offline owned tracer did not exit');
      },
    };
  } catch (error) {
    owned?.kill('SIGTERM');
    input?.destroy();
    stdout?.destroy();
    for (const fd of descriptors) closeSync(fd);
    rmSync(inputPath, { force: true });
    rmSync(outputPath, { force: true });
    throw error;
  }
}
