import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync } from 'node:fs';

export type RegularStdioOptions = Omit<
  SpawnSyncOptionsWithStringEncoding,
  'stdio' | 'encoding' | 'shell'
> & { stdoutPath: string; stderrPath: string };

export function runWithRegularStdio(
  executable: string,
  args: string[],
  { stdoutPath, stderrPath, ...options }: RegularStdioOptions,
) {
  const stdoutFd = openSync(stdoutPath, 'wx', 0o600);
  let stderrFd: number | undefined;
  let result: SpawnSyncReturns<string>;
  try {
    stderrFd = openSync(stderrPath, 'wx', 0o600);
    result = spawnSync(executable, args, {
      ...options,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
  // Node maxBuffer applies to pipes, not file descriptors. Bound reads separately;
  // this is not a disk quota or a sandbox for arbitrary/unreviewed executables.
  const limit = options.maxBuffer ?? 1_048_576;
  if (statSync(stdoutPath).size > limit || statSync(stderrPath).size > limit) {
    throw new Error('Owned-child output exceeds its capture limit');
  }
  return {
    ...result,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}
