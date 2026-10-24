import { execa } from 'execa';
import { ToolExecutionError } from '../core/tool-errors.js';
import { sanitizedSubprocessEnvironment } from '../security/environment.js';
import { redactText } from '../security/redaction.js';

export class HostCommandError extends ToolExecutionError {
  constructor(detail: string) {
    super(
      `Host command failed after launch: ${detail}. Side effects may have occurred. Do not retry automatically; inspect the destination or ask the user first.`,
      'HOST_EFFECT_UNCERTAIN',
      'uncertain',
      'inspect_destination',
    );
    this.name = 'HostCommandError';
  }
}

export class HostLaunchRejectedError extends ToolExecutionError {
  constructor(command: string) {
    super(
      `Executable not found or working directory missing: ${command}. No command was executed. Check the exact executable and working directory before choosing a valid invocation.`,
      'HOST_LAUNCH_REJECTED',
      'not_executed',
      'discover_executable',
    );
    this.name = 'HostLaunchRejectedError';
  }
}

// This is explicitly host-account execution, NOT a filesystem sandbox.
export async function runHostCommand(
  command: string,
  args: string[],
  root: string,
  options: { stdin?: string; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  if (!command || command.includes('\0'))
    throw new Error('A literal executable name or path is required');
  const result = await execa(command, args, {
    cwd: root,
    env: sanitizedSubprocessEnvironment(),
    extendEnv: false,
    shell: false,
    reject: false,
    input: options.stdin,
    timeout: options.timeoutMs ?? 30000,
    cancelSignal: options.signal,
    maxBuffer: 256000,
    windowsHide: true,
  });
  options.signal?.throwIfAborted();
  const failure = result as { timedOut?: boolean; isMaxBuffer?: boolean; code?: string };
  if (failure.code === 'ENOENT') throw new HostLaunchRejectedError(command);
  const oversized = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 256000;
  if (result.failed || result.exitCode !== 0 || oversized) {
    const detail = failure.timedOut
      ? 'timeout exceeded'
      : failure.isMaxBuffer || oversized
        ? 'output limit exceeded'
        : `exit ${result.exitCode ?? 'unknown'}${result.stderr ? `; ${redactText(result.stderr).slice(0, 1000)}` : ''}`;
    throw new HostCommandError(detail);
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
