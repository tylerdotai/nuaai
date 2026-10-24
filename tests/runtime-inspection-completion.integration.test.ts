import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

const input =
  'I prefer blue controls for this project. Use runtime.inspect to report the actual provider, model, approval mode, and whether automatic learning is enabled. Do not use memory.store, execute commands, change settings, or take any external action.';

it.each(['runtime.inspect', 'workspace.list'] as const)(
  'requires relevant runtime evidence, not unrelated activity, when forbidden dotted tool names appear: %s',
  async (tool) => {
    const h = await identityHarness(undefined, (config) => {
      config.limits.maxContextTokens = 64_000;
    });
    vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
      if (request.conversationId?.startsWith('knowledge:')) {
        yield { type: 'done', text: '{"candidates":[]}' };
        return;
      }
      if (!request.messages.some((message) => message.role === 'tool'))
        yield { type: 'tool_call', id: 'inspection-evidence', name: tool, arguments: {} };
      else yield { type: 'done', text: 'I inspected the runtime state.' };
    });
    try {
      const created = h.daemon.runtime.createSession(
        'Runtime verification',
        `runtime-verification-${tool}`,
        undefined,
        { workspaceRoot: h.project },
      );
      const accepted = await h.api('/api/runs', { threadId: created.thread.id, input });
      const terminal = await h.daemon.runtime.waitForRun(accepted.body.id);
      expect(terminal.status).toBe(tool === 'runtime.inspect' ? 'completed' : 'failed');
      if (tool === 'runtime.inspect') {
        const observation = h.daemon.store
          .listRecentEventsForRun(accepted.body.id, 100)
          .find((event) => event.type === 'tool.completed');
        expect(observation?.payload.result).toMatchObject({ context: { maxContextUnits: 64_000 } });
      }
    } finally {
      await h.close();
    }
  },
  15_000,
);
