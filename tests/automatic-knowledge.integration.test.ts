import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import type { ProviderRequest } from '../src/providers/types.js';
import { identityHarness } from './identity.harness.js';

it('selectively learns a direct preference without a save request, deduplicates it and recalls it only in the matching workspace', async () => {
  const h = await identityHarness();
  let reviews = 0;
  const mainRequests: ProviderRequest[] = [];
  const quote = 'I prefer blue controls for this project';
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
              sourceQuote: quote,
              evidenceCallIds: [],
              confidence: 'high',
            },
          ],
        }),
      };
    } else {
      mainRequests.push(request);
      yield { type: 'done', text: 'Understood.' };
    }
  });
  const run = async (threadId: string, input: string) => {
    const accepted = await h.api('/api/runs', { threadId, input });
    expect(accepted.status).toBe(200);
    expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
    return accepted.body.id as string;
  };
  try {
    const first = h.daemon.runtime.createSession(
      'Preference source',
      'ui-learning-source',
      undefined,
      { workspaceRoot: h.project },
    );
    await run(first.thread.id, 'Hello.');
    expect(reviews).toBe(0);
    const sourceRun = await run(first.thread.id, `${quote}.`);
    await expect
      .poll(
        () =>
          h.daemon.store
            .searchMemoryRows()
            .filter((memory) => memory.content.includes('blue controls')).length,
        { timeout: 5000 },
      )
      .toBe(1);
    const memory = h.daemon.store
      .searchMemoryRows()
      .find((entry) => entry.content.includes('blue controls'));
    expect(memory?.content).toBe('The user prefers blue controls for this project.');
    expect(memory?.metadata.knowledge).toMatchObject({
      scope: 'workspace',
      workspaceRoot: h.project,
      sourceRunId: sourceRun,
      kind: 'preference',
    });
    await run(first.thread.id, `${quote}.`);
    await expect
      .poll(
        () =>
          h.daemon.store
            .listTasks()
            .filter(
              (task) =>
                task.kind === 'knowledge.review' && ['queued', 'running'].includes(task.status),
            ).length,
      )
      .toBe(0);
    expect(
      h.daemon.store.searchMemoryRows().filter((entry) => entry.content.includes('blue controls')),
    ).toHaveLength(1);
    const fresh = h.daemon.runtime.createSession(
      'Fresh matching session',
      'ui-learning-fresh',
      undefined,
      { workspaceRoot: h.project },
    );
    await run(fresh.thread.id, 'Respond using any applicable controls color preference.');
    expect(mainRequests.at(-1)?.systemPrompt).toContain('blue controls');
    const outside = join(h.root, 'another-project');
    await mkdir(outside);
    const other = h.daemon.runtime.createSession(
      'Other workspace',
      'ui-learning-other',
      undefined,
      { workspaceRoot: outside },
    );
    await run(other.thread.id, 'Respond using any applicable controls color preference.');
    expect(mainRequests.at(-1)?.systemPrompt).not.toContain('blue controls');
  } finally {
    await h.close();
  }
}, 15_000);
