import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  bindOwnedFifoChild,
  offlineHelperTraceArgs,
  openActualHelper,
} from './actual-helper-host.js';

function fixture() {
  const process = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const bound = bindOwnedFifoChild(process as unknown as ChildProcess, input, output);
  return { process, input, output, ...bound };
}

describe('portable actual-helper host extraction (no native execution)', () => {
  it('keeps the exact all-network/uring/raw/follow-descendants denial argv', () => {
    expect(offlineHelperTraceArgs('/owned/helper', '/owned/trace')).toEqual([
      '--kill-on-exit',
      '-f',
      '-qq',
      '-e',
      'trace=%network,io_uring_setup,io_uring_enter,io_uring_register,execve,execveat,close_range',
      '-e',
      'raw=all',
      '--inject=%network,io_uring_setup,io_uring_enter,io_uring_register:error=EPERM',
      '-o',
      '/owned/trace',
      '/owned/helper',
    ]);
  });

  it('holds close until stdout EOF when process exit happens first', async () => {
    const f = fixture();
    const close = vi.fn();
    f.child.on('close', close);
    f.process.exitCode = 0;
    f.process.emit('exit', 0, null);
    expect(f.child.exitCode).toBe(0);
    expect(close).not.toHaveBeenCalled();
    f.output.end('final bytes');
    await immediate();
    expect(f.eof()).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(0, null);
    f.input.destroy();
  });

  it('holds close until exit when stdout EOF happens first and closes once', async () => {
    const f = fixture();
    const close = vi.fn();
    f.child.on('close', close);
    f.output.end();
    await immediate();
    expect(f.eof()).toBe(true);
    expect(close).not.toHaveBeenCalled();
    f.process.exitCode = 0;
    f.process.emit('exit', 0, null);
    f.process.emit('exit', 0, null);
    expect(close).toHaveBeenCalledOnce();
    f.child.kill('SIGTERM');
    expect(f.process.kill).toHaveBeenCalledWith('SIGTERM');
    f.input.destroy();
  });

  it('forwards only owned process errors without formatting raw diagnostics', () => {
    const f = fixture();
    const receive = vi.fn();
    f.child.on('error', receive);
    const error = new Error('synthetic failure');
    f.process.emit('error', error);
    expect(receive).toHaveBeenCalledWith(error);
    f.input.destroy();
    f.output.destroy();
  });

  it('rejects a missing approved digest before touching an executable or evidence', async () => {
    await expect(
      openActualHelper({
        binary: '/not-opened',
        sha256: 'not-a-digest',
        evidenceRoot: '/not-created',
      }),
    ).rejects.toThrow('Explicit approved ELF digest');
  });

  it('rejects an ELF digest mismatch before mkdir/mkfifo/spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nuaai-helper-host-unit-'));
    try {
      const binary = join(root, 'fake-not-executed');
      const evidenceRoot = join(root, 'evidence');
      writeFileSync(binary, 'pure unit data only');
      await expect(
        openActualHelper({ binary, sha256: '0'.repeat(64), evidenceRoot }),
      ).rejects.toThrow('Offline helper ELF changed');
      expect(existsSync(evidenceRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
