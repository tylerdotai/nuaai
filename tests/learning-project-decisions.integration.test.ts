import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('learns an authored project decision without a remember command, but does not review an ordinary follow-up question', async () => {
  const h = await identityHarness();
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (request.conversationId?.startsWith('knowledge:'))
      yield {
        type: 'done',
        text: JSON.stringify({
          candidates: [
            {
              kind: 'fact',
              topic: 'workspace.storage',
              content: 'Use SQLite for workspace data in this project.',
              scope: 'workspace',
              sourceQuote: 'We use SQLite for workspace data in this project',
              evidenceCallIds: [],
              confidence: 'high',
            },
          ],
        }),
      };
    else yield { type: 'done', text: 'Understood.' };
  });
  try {
    const created = h.daemon.runtime.createSession(
      'Project decisions',
      'project-decision-learning',
      undefined,
      { workspaceRoot: h.project },
    );
    const first = await h.api('/api/runs', {
      threadId: created.thread.id,
      input: 'We use SQLite for workspace data in this project.',
    });
    expect((await h.daemon.runtime.waitForRun(first.body.id)).status).toBe('completed');
    await expect
      .poll(() => h.daemon.store.taskForSource('knowledge.review', first.body.id)?.status)
      .toBe('completed');
    expect(h.daemon.store.searchMemoryRows().map((note) => note.content)).toEqual([
      'Use SQLite for workspace data in this project.',
    ]);
    const second = await h.api('/api/runs', {
      threadId: created.thread.id,
      input: 'Can you explain what SQLite is?',
    });
    expect((await h.daemon.runtime.waitForRun(second.body.id)).status).toBe('completed');
    expect(h.daemon.store.taskForSource('knowledge.review', second.body.id)).toBeUndefined();
  } finally {
    await h.close();
  }
}, 15_000);
