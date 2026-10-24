import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import type { ProviderRequest } from '../src/providers/types.js';
import { identityHarness } from './identity.harness.js';

it('retains learned provenance and off mode across daemon restart, recalls existing knowledge, and does not replay a completed review', async () => {
  const h = await identityHarness();
  const main: ProviderRequest[] = [];
  let reviews = 0;
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (request.conversationId?.startsWith('knowledge:')) {
      reviews += 1;
      yield {
        type: 'done',
        text: JSON.stringify({
          candidates: [
            {
              kind: 'preference',
              topic: 'ui.controls.color',
              content: 'The user prefers blue controls for this project.',
              scope: 'workspace',
              sourceQuote: 'I prefer blue controls for this project',
              evidenceCallIds: [],
              confidence: 'high',
            },
          ],
        }),
      };
    } else {
      main.push(request);
      yield { type: 'done', text: 'Understood.' };
    }
  });
  try {
    const first = h.daemon.runtime.createSession(
      'Before learning restart',
      'learning-restart-before',
      undefined,
      { workspaceRoot: h.project },
    );
    const accepted = await h.api('/api/runs', {
      threadId: first.thread.id,
      input: 'I prefer blue controls for this project.',
    });
    expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
    await expect
      .poll(() => h.daemon.store.taskForSource('knowledge.review', accepted.body.id)?.status)
      .toBe('completed');
    const original = (await h.api('/api/memory')).body.memories;
    expect(original).toEqual([
      expect.objectContaining({
        content: 'The user prefers blue controls for this project.',
        metadata: {
          knowledge: expect.objectContaining({
            origin: 'automatic',
            state: 'active',
            sourceRunId: accepted.body.id,
            workspaceRoot: h.project,
          }),
        },
      }),
    ]);
    expect((await h.api('/api/memory/learning', { mode: 'off' })).status).toBe(200);
    await h.restart();
    expect((await h.api('/api/memory/learning')).body).toMatchObject({
      available: true,
      enabled: false,
      mode: 'off',
    });
    expect((await h.api('/api/memory')).body.memories).toEqual(original);
    expect(h.daemon.store.taskForSource('knowledge.review', accepted.body.id)?.status).toBe(
      'completed',
    );
    const fresh = h.daemon.runtime.createSession(
      'After learning restart',
      'learning-restart-after',
      undefined,
      { workspaceRoot: h.project },
    );
    const recalled = await h.api('/api/runs', {
      threadId: fresh.thread.id,
      input: 'What saved controls color applies to this project?',
    });
    expect((await h.daemon.runtime.waitForRun(recalled.body.id)).status).toBe('completed');
    expect(main.at(-1)?.systemPrompt).toContain('The user prefers blue controls for this project.');
    expect(h.daemon.store.taskForSource('knowledge.review', recalled.body.id)).toBeUndefined();
    expect(reviews).toBe(1);
  } finally {
    await h.close();
  }
}, 15_000);
