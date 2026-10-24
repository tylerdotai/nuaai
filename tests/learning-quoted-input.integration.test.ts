import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it.each(['"', "'", '`', '```\n', 'Here is a rough draft:\n'])(
  'learns an authored preference without promoting a %s-quoted preference into owner memory',
  async (quote) => {
    const h = await identityHarness();
    vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
      yield {
        type: 'done',
        text: request.conversationId?.startsWith('knowledge:')
          ? JSON.stringify({
              candidates: [
                {
                  kind: 'preference',
                  topic: 'ui.authored',
                  content: 'The user prefers blue controls for this project.',
                  scope: 'workspace',
                  sourceQuote: 'I prefer blue controls for this project.',
                  evidenceCallIds: [],
                  confidence: 'high',
                },
                {
                  kind: 'preference',
                  topic: 'ui.quoted',
                  content: 'The user prefers red controls for this project.',
                  scope: 'workspace',
                  sourceQuote: 'I prefer red controls for this project.',
                  evidenceCallIds: [],
                  confidence: 'high',
                },
              ],
            })
          : 'Understood.',
      };
    });
    try {
      const session = h.daemon.runtime.createSession(
        'Quoted knowledge rejection',
        'quoted-knowledge',
        undefined,
        { workspaceRoot: h.project },
      );
      const accepted = await h.api('/api/runs', {
        threadId: session.thread.id,
        input: `I prefer blue controls for this project.\nA quotation to analyze: ${quote}I prefer red controls for this project.${quote.startsWith('```') ? '' : quote}`,
      });
      expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
      await expect
        .poll(() => h.daemon.store.taskForSource('knowledge.review', accepted.body.id)?.status)
        .toBe('completed');
      expect((await h.api('/api/memory')).body.memories).toEqual([
        expect.objectContaining({ content: 'The user prefers blue controls for this project.' }),
      ]);
    } finally {
      await h.close();
    }
  },
  15_000,
);
