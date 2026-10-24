import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import type { ProviderRequest } from '../src/providers/types.js';
import { identityHarness } from './identity.harness.js';

it('preserves correction history and can undo the current automatic note without deleting either version', async () => {
  const h = await identityHarness();
  const requests: ProviderRequest[] = [];
  let color = 'blue';
  let supersedes: string | undefined;
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (request.conversationId?.startsWith('knowledge:'))
      yield {
        type: 'done',
        text: JSON.stringify({
          candidates: [
            {
              kind: 'preference',
              topic: 'ui.controls.color',
              content: `The user prefers ${color} controls for this project.`,
              scope: 'workspace',
              sourceQuote: `I prefer ${color} controls for this project`,
              evidenceCallIds: [],
              confidence: 'high',
              ...(supersedes ? { supersedes } : {}),
            },
          ],
        }),
      };
    else {
      requests.push(request);
      yield { type: 'done', text: 'Understood.' };
    }
  });
  const run = async (threadId: string, input: string) => {
    const accepted = await h.api('/api/runs', { threadId, input });
    expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
  };
  try {
    const first = h.daemon.runtime.createSession(
      'Preference revision',
      'learning-undo',
      undefined,
      { workspaceRoot: h.project },
    );
    await run(first.thread.id, 'I prefer blue controls for this project.');
    await expect
      .poll(
        () =>
          h.daemon.store
            .searchMemoryRows()
            .find((memory) => memory.content.includes('blue controls')),
        { timeout: 5000 },
      )
      .toBeDefined();
    const blue = h.daemon.store
      .searchMemoryRows()
      .find((memory) => memory.content.includes('blue controls'));
    if (!blue) throw new Error('Expected persisted blue preference');
    color = 'green';
    supersedes = blue.id;
    await run(first.thread.id, 'I prefer green controls for this project.');
    await expect
      .poll(
        () =>
          h.daemon.store
            .searchMemoryRows()
            .find((memory) => memory.content.includes('green controls')),
        { timeout: 5000 },
      )
      .toBeDefined();
    const green = h.daemon.store
      .searchMemoryRows()
      .find((memory) => memory.content.includes('green controls'));
    if (!green) throw new Error('Expected persisted corrected preference');
    expect(
      h.daemon.store.searchMemoryRows().find((memory) => memory.id === blue.id)?.metadata.knowledge,
    ).toMatchObject({ state: 'superseded', supersededBy: green.id });
    const fresh = h.daemon.runtime.createSession('Before undo', 'learning-undo-before', undefined, {
      workspaceRoot: h.project,
    });
    await run(fresh.thread.id, 'Respond using any applicable controls color preference.');
    expect(requests.at(-1)?.systemPrompt).toContain('green controls');
    expect(requests.at(-1)?.systemPrompt).not.toContain('blue controls');
    expect(await h.api(`/api/memory/${encodeURIComponent(green.id)}/revert`, {})).toMatchObject({
      status: 200,
      body: { reverted: true, restoredId: blue.id },
    });
    const history = h.daemon.store.searchMemoryRows();
    expect(history.find((memory) => memory.id === green.id)?.metadata.knowledge).toMatchObject({
      state: 'disabled',
      supersedes: blue.id,
    });
    expect(history.find((memory) => memory.id === blue.id)?.metadata.knowledge).toMatchObject({
      state: 'active',
    });
    const restored = h.daemon.runtime.createSession(
      'After undo',
      'learning-undo-after',
      undefined,
      { workspaceRoot: h.project },
    );
    await run(restored.thread.id, 'Respond using any applicable controls color preference.');
    expect(requests.at(-1)?.systemPrompt).toContain('blue controls');
    expect(requests.at(-1)?.systemPrompt).not.toContain('green controls');
  } finally {
    await h.close();
  }
}, 15_000);
