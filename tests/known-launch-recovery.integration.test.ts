import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import type { ProviderRequest } from '../src/providers/types.js';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';

it('recovers from an observed pre-launch rejection and verifies the corrected executable without treating uncertain launched commands as safe retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-known-launch-recovery-'));
  const store = new DatabaseStore(openAppDatabase(root));
  let turn = 0;
  const provider = {
    name: 'capture',
    model: 'capture',
    embed: async () => [],
    async *stream(request: ProviderRequest) {
      turn += 1;
      if (turn === 1)
        yield {
          type: 'tool_call' as const,
          id: 'missing-executable',
          name: 'host.command',
          arguments: { command: join(root, 'not-installed'), args: ['--version'] },
        };
      else if (turn === 2)
        yield {
          type: 'tool_call' as const,
          id: 'corrected-executable',
          name: 'host.command',
          arguments: { command: process.execPath, args: ['--version'] },
        };
      else {
        const observation = request.messages
          .filter(
            (message) => message.role === 'tool' && message.toolCallId === 'corrected-executable',
          )
          .at(-1);
        const actual = JSON.parse(observation?.content ?? '{}') as { stdout?: string };
        yield {
          type: 'done' as const,
          text: `The real Node process reports ${actual.stdout?.trim()}.`,
        };
      }
    },
  };
  const runtime = new AgentRuntime({
    root,
    store,
    config: defaultRuntimeConfig(root),
    tools: new ToolRegistry(root),
    providers: { get: () => provider, list: () => ['capture'] } as never,
  });
  try {
    const created = runtime.createSession('Recover launch rejection');
    runtime.setSessionApprovalPolicy(created.session.id, 'unguarded');
    const run = runtime.startRun({
      threadId: created.thread.id,
      provider: 'capture',
      permissions: permissionContextForProfile('operator'),
      input: 'Report the installed Node version from a real process.',
    });
    const result = await runtime.waitForRun(run.id);
    expect(result.status, result.output).toBe('completed');
    const events = store.listRecentEventsForRun(run.id, 100);
    expect(events.find((event) => event.type === 'tool.failed')?.payload).toMatchObject({
      id: 'missing-executable',
      executionState: 'not_executed',
      failureCode: 'HOST_LAUNCH_REJECTED',
    });
    expect(events.find((event) => event.type === 'tool.completed')?.payload).toMatchObject({
      id: 'corrected-executable',
      result: { exitCode: 0 },
    });
    expect(result.output).toContain('The real Node process reports v');
  } finally {
    await runtime.shutdown();
    store.close();
  }
}, 15_000);
