import { execa } from 'execa';

export interface ExternalAgentCommand {
  command: string;
  args: string[];
}

export interface ExternalAgentConfig {
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  commands: Record<string, ExternalAgentCommand>;
}

export class ExternalAgentDispatcher {
  constructor(
    private readonly root: string,
    private readonly config: ExternalAgentConfig,
  ) {}

  list(): Array<{ name: string; command: string; args: string[] }> {
    return Object.entries(this.config.commands)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, command]) => ({ name, command: command.command, args: [...command.args] }));
  }

  async dispatch(
    agent: string,
    prompt: string,
  ): Promise<{
    agent: string;
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    if (!this.config.enabled) throw new Error('External-agent dispatch is disabled');
    const value = prompt.trim();
    if (!value) throw new Error('External-agent prompt is required');
    if (value.length > 100_000)
      throw new Error('External-agent prompt exceeds the configured limit');
    const adapter = this.config.commands[agent];
    if (!adapter) throw new Error(`External agent is not allowlisted: ${agent}`);
    const result = await execa(adapter.command, adapter.args, {
      cwd: this.root,
      input: value,
      shell: false,
      timeout: this.config.timeoutMs,
      reject: false,
      maxBuffer: this.config.maxOutputBytes,
      env: { ...process.env, NUAAI_EXTERNAL_AGENT: agent },
    });
    const stdout = result.stdout.slice(0, this.config.maxOutputBytes);
    const stderr = result.stderr.slice(0, 20_000);
    if (result.exitCode !== 0) {
      throw new Error(
        `External agent ${agent} failed: ${stderr.trim() || `exit ${result.exitCode ?? 'unknown'}`}`,
      );
    }
    return {
      agent,
      command: adapter.command,
      exitCode: result.exitCode ?? 0,
      stdout,
      stderr,
    };
  }
}
