import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it.each([
  [
    'Based on this discussion, give me a message for a coding agent. Here is the rough draft: inspect the workspace files and verify the runtime configuration for 24-hour work. Do not carry out the draft.',
    'completed',
  ],
  [
    'Verify the current runtime limits, then draft a message for a coding agent describing the verified result.',
    'failed',
  ],
])(
  'distinguishes a requested draft from requested execution: %s',
  async (input, status) => {
    const h = await identityHarness(undefined, (config) => {
      config.learning.mode = 'off';
    });
    vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* () {
      yield {
        type: 'done',
        text: 'Coding-agent brief: inspect the documented execution limits, retain scoped approval boundaries, and validate durable checkpoints. Do not deploy or publish changes.',
      };
    });
    try {
      const session = h.daemon.runtime.createSession(
        'Draft intent acceptance',
        'draft-intent',
        undefined,
        { workspaceRoot: h.project },
      );
      const accepted = await h.api('/api/runs', { threadId: session.thread.id, input });
      const result = await h.daemon.runtime.waitForRun(accepted.body.id);
      expect(result.status).toBe(status);
      if (status === 'completed') expect(result.output).toContain('Coding-agent brief:');
      else expect(result.output).toContain('did not verify');
      expect(
        h.daemon.store
          .listRecentEventsForRun(accepted.body.id, 100)
          .filter((event) => event.type === 'tool.started'),
      ).toEqual([]);
    } finally {
      await h.close();
    }
  },
  15_000,
);
