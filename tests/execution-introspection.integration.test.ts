import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('exposes the bound continuous policy and actual admission budget through the advertised native inspection tool', async () => {
  const h = await identityHarness(undefined, (config) => {
    config.learning.mode = 'off';
    config.limits.maxTurns = 7;
    config.limits.providerTimeoutMs = 3210;
  });
  let inspection: unknown;
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    const result = request.messages.find((message) => message.toolName === 'runtime.inspect');
    if (result) {
      inspection = JSON.parse(result.content);
      yield {
        type: 'done',
        text: 'The recorded runtime execution policy and limits have been inspected.',
      };
      return;
    }
    yield {
      type: 'tool_call',
      id: 'inspect-execution',
      name: 'runtime.inspect',
      arguments: { section: 'overview' },
    };
  });
  try {
    const parent = h.daemon.runtime.createSession(
      'Execution limits',
      'execution-limits',
      undefined,
      { workspaceRoot: h.project },
    );
    const accepted = await h.api('/api/runs', {
      threadId: parent.thread.id,
      input: 'Inspect your current runtime execution policy, limits and remaining goal budget.',
      execution: { mode: 'continuous', durationMs: 86_400_000, maxRuns: 6 },
    });
    const result = await h.daemon.runtime.waitForRun(accepted.body.id);
    expect(result.status, result.output).toBe('completed');
    expect(inspection).toMatchObject({
      execution: {
        goal: {
          mode: 'continuous',
          durationMs: 86_400_000,
          maxRuns: 6,
          admissionsUsed: 1,
          admissionsRemaining: 5,
        },
        slice: { maxTurns: 7, modelTimeoutMs: 3210 },
      },
    });
    expect(inspection).not.toHaveProperty('execution.uninterrupted');
  } finally {
    await h.close();
  }
});
