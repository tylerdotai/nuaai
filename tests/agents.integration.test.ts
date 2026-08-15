import { describe, expect, it } from 'vitest';

import { ExternalAgentDispatcher } from '../src/integrations/agents.js';
import { ToolRegistry } from '../src/tools/registry.js';

const readOnly = { approved: new Set(['read'] as const), capabilities: { filesystem: true } };
const executable = {
  approved: new Set(['read', 'write', 'execute'] as const),
  capabilities: { filesystem: true, subprocess: true },
};

function adapter(command: string, args: string[] = []) {
  return { command, args };
}

describe('bounded external-agent dispatch', () => {
  it('runs a configured adapter through stdin and returns its real output', async () => {
    const dispatcher = new ExternalAgentDispatcher('/tmp', {
      enabled: true,
      timeoutMs: 5_000,
      maxOutputBytes: 2_000,
      commands: {
        uppercase: adapter(process.execPath, [
          '-e',
          "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s.toUpperCase()))",
        ]),
      },
    });
    await expect(dispatcher.dispatch('uppercase', 'hello')).resolves.toMatchObject({
      agent: 'uppercase',
      exitCode: 0,
      stdout: 'HELLO',
    });
    expect(dispatcher.list()).toEqual([
      expect.objectContaining({ name: 'uppercase', command: process.execPath }),
    ]);
  });

  it('rejects disabled, unknown, empty, failing, and timed-out adapters truthfully', async () => {
    const disabled = new ExternalAgentDispatcher('/tmp', {
      enabled: false,
      timeoutMs: 50,
      maxOutputBytes: 2_000,
      commands: {},
    });
    await expect(disabled.dispatch('anything', 'prompt')).rejects.toThrow('disabled');

    const dispatcher = new ExternalAgentDispatcher('/tmp', {
      enabled: true,
      timeoutMs: 50,
      maxOutputBytes: 2_000,
      commands: {
        fail: adapter(process.execPath, [
          '-e',
          "process.stderr.write('adapter failed');process.exit(2)",
        ]),
        hang: adapter(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)']),
      },
    });
    await expect(dispatcher.dispatch('missing', 'prompt')).rejects.toThrow('not allowlisted');
    await expect(dispatcher.dispatch('fail', 'prompt')).rejects.toThrow('adapter failed');
    await expect(dispatcher.dispatch('hang', 'prompt')).rejects.toThrow('failed');
    await expect(dispatcher.dispatch('fail', '   ')).rejects.toThrow('prompt is required');
  });

  it('exposes dispatch only with execute permission through the model-facing registry', async () => {
    const dispatcher = new ExternalAgentDispatcher('/tmp', {
      enabled: true,
      timeoutMs: 5_000,
      maxOutputBytes: 2_000,
      commands: {
        uppercase: adapter(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)']),
      },
    });
    const tools = new ToolRegistry('/tmp', undefined, {}, { agents: dispatcher });
    await expect(
      tools.execute(
        'agent.dispatch',
        { agent: 'uppercase', prompt: 'hello' },
        {
          root: '/tmp',
          permissions: readOnly,
        },
      ),
    ).rejects.toThrow('Permission required: execute');
    await expect(
      tools.execute(
        'agent.dispatch',
        { agent: 'uppercase', prompt: 'hello' },
        {
          root: '/tmp',
          permissions: executable,
        },
      ),
    ).resolves.toMatchObject({ stdout: 'hello', exitCode: 0 });
  });
});
