import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('learns a reusable verified repair from actual successful observations, not the rejected invocation', async () => {
  const h = await identityHarness();
  await writeFile(join(h.project, 'lesson.txt'), 'VERIFIED_CONTENT');
  let step = 0;
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (request.conversationId?.startsWith('knowledge:')) {
      yield {
        type: 'done',
        text: JSON.stringify({
          candidates: [
            {
              kind: 'procedure',
              topic: 'workspace.inspect-content-and-metadata',
              content:
                'When checking project notes, inspect both the content and the metadata using read and stat instead of guessing.',
              scope: 'workspace',
              sourceQuote: '',
              evidenceCallIds: ['good-read', 'good-stat'],
              confidence: 'high',
            },
          ],
        }),
      };
      return;
    }
    step += 1;
    if (step === 1)
      yield { type: 'tool_call', id: 'rejected-read', name: 'workspace.read', arguments: {} };
    else if (step === 2)
      yield {
        type: 'tool_call',
        id: 'good-read',
        name: 'workspace.read',
        arguments: { path: 'lesson.txt' },
      };
    else if (step === 3)
      yield {
        type: 'tool_call',
        id: 'good-stat',
        name: 'workspace.stat',
        arguments: { path: 'lesson.txt' },
      };
    else
      yield {
        type: 'done',
        text: 'lesson.txt contains VERIFIED_CONTENT; its metadata was inspected.',
      };
  });
  try {
    const created = h.daemon.runtime.createSession(
      'Verified repair',
      'verified-repair-source',
      undefined,
      { workspaceRoot: h.project },
    );
    const accepted = await h.api('/api/runs', {
      threadId: created.thread.id,
      input: 'Read lesson.txt, inspect its metadata and report the content.',
    });
    const result = await h.daemon.runtime.waitForRun(accepted.body.id);
    expect(result.status, result.output).toBe('completed');
    await expect
      .poll(
        () =>
          h.daemon.store
            .searchMemoryRows()
            .find((memory) => memory.content.includes('inspect both the content')),
        { timeout: 5000 },
      )
      .toBeDefined();
    const learned = h.daemon.store
      .searchMemoryRows()
      .find((memory) => memory.content.includes('inspect both the content'));
    expect(learned?.metadata.knowledge).toMatchObject({
      sourceRunId: result.id,
      kind: 'procedure',
      evidenceCallIds: ['good-read', 'good-stat'],
      scope: 'workspace',
      workspaceRoot: h.project,
    });
    const rejected = h.daemon.store
      .listRecentEventsForRun(result.id, 100)
      .find((event) => event.type === 'tool.failed');
    expect(rejected?.payload).toMatchObject({
      id: 'rejected-read',
      executionState: 'not_executed',
    });
  } finally {
    await h.close();
  }
}, 15_000);
