import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWithRegularStdio } from './regular-stdio.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nuaai-stdio-test-'));
  roots.push(root);
  return {
    cwd: root,
    env: { HOME: root },
    timeout: 5_000,
    stdoutPath: join(root, 'stdout'),
    stderrPath: join(root, 'stderr'),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const inspectStdio = `
  const fs = require('node:fs');
  process.stdout.write(JSON.stringify({
    stdinSocket: fs.fstatSync(0).isSocket(),
    stdoutFile: fs.fstatSync(1).isFile(),
    stderrFile: fs.fstatSync(2).isFile(),
  }));
`;

describe('owned-child regular stdio boundary', () => {
  it('passes regular files, not Node pipe/socket endpoints, to the child', () => {
    const options = fixture();
    const result = runWithRegularStdio(process.execPath, ['-e', inspectStdio], options);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      stdinSocket: false,
      stdoutFile: true,
      stderrFile: true,
    });
    expect(readFileSync(options.stdoutPath, 'utf8')).toBe(result.stdout);
    expect(result.stderr).toBe('');
    expect(statSync(options.stdoutPath).mode & 0o777).toBe(0o600);
    expect(statSync(options.stderrPath).mode & 0o777).toBe(0o600);
  });

  it('retains a negative control showing Node pipe stdio is not a regular file', () => {
    const result = spawnSync(process.execPath, ['-e', inspectStdio], {
      env: {},
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).stdoutFile).toBe(false);
    expect(JSON.parse(result.stdout).stderrFile).toBe(false);
  });

  it('preserves nonzero status and diagnostic output rather than reporting success', () => {
    const options = fixture();
    const result = runWithRegularStdio(
      process.execPath,
      ['-e', "process.stderr.write('fixed fixture diagnostic');process.exitCode=7"],
      options,
    );
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('fixed fixture diagnostic');
  });

  it('fails rather than overwriting an existing output or following its path', () => {
    const options = fixture();
    writeFileSync(options.stdoutPath, 'preserve fixture');
    expect(() =>
      runWithRegularStdio(process.execPath, ['-e', 'process.exit(0)'], options),
    ).toThrow();
    expect(readFileSync(options.stdoutPath, 'utf8')).toBe('preserve fixture');
  });

  it('bounds file capture reads independently of Node pipe-only maxBuffer', () => {
    const options = fixture();
    expect(() =>
      runWithRegularStdio(process.execPath, ['-e', "process.stdout.write('x'.repeat(80))"], {
        ...options,
        maxBuffer: 16,
      }),
    ).toThrow('Owned-child output exceeds its capture limit');
  });
});
