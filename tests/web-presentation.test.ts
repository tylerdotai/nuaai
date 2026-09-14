import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEvent } from '../src/core/events.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { buildThreadPresentation } from '../src/web/presentation.js';

const stores: DatabaseStore[] = [];

async function createStore(): Promise<{ root: string; store: DatabaseStore }> {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-web-presentation-'));
  const store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  return { root, store };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('structured conversation presentation', () => {
  it('projects a failed run identically after reload with unique terminal tools and safe artifacts', async () => {
    const { root, store } = await createStore();
    const created = store.createSession('Presentation', 100);
    const run = store.createRun(
      created.thread.id,
      'Review the repository',
      'codex',
      'gpt-test',
      'presentation-failed',
      110,
    );
    const user = store.addMessage(
      created.thread.id,
      'user',
      'Review the repository',
      'codex',
      'gpt-test',
      111,
    );
    store.storeMessageArtifact(user.id, 'run_link', { runId: run.id }, 111);
    const intermediate = store.addMessage(
      created.thread.id,
      'assistant',
      'I am inspecting the repository.',
      'codex',
      'gpt-test',
      112,
    );
    store.storeMessageArtifact(
      intermediate.id,
      'tool_calls',
      { calls: [{ id: 'tool-1', name: 'workspace.read' }] },
      112,
    );
    store.storeMessageArtifact(intermediate.id, 'run_link', { runId: run.id }, 112);
    const final = store.addMessage(
      created.thread.id,
      'assistant',
      '## Review\n\nThe run failed safely.',
      'codex',
      'gpt-test',
      120,
    );
    store.storeMessageArtifact(final.id, 'run_link', { runId: run.id }, 120);
    store.storeMessageArtifact(final.id, 'future_block', { secret: 'must-not-render' }, 120);
    store.updateRun(
      run.id,
      { status: 'failed', output: 'Run failed because the provider disconnected.' },
      121,
    );

    const eventContext = {
      sessionId: created.session.id,
      threadId: created.thread.id,
      runId: run.id,
    };
    store.appendEvent(
      createEvent('run.started', { provider: 'codex', model: 'gpt-test' }, eventContext),
    );
    store.appendEvent(
      createEvent(
        'tool.started',
        { id: 'tool-1', name: 'workspace.read', arguments: { path: 'src/server.ts' } },
        eventContext,
      ),
    );
    store.appendEvent(
      createEvent(
        'tool.started',
        { id: 'tool-1', name: 'workspace.read', arguments: { path: 'src/server.ts' } },
        eventContext,
      ),
    );
    store.appendEvent(
      createEvent(
        'tool.completed',
        { id: 'tool-1', name: 'workspace.read', result: { bytes: 42 } },
        eventContext,
      ),
    );
    store.appendEvent(
      createEvent(
        'tool.started',
        { id: 'tool-2', name: 'workspace.search', arguments: { query: 'unsafe' } },
        eventContext,
      ),
    );
    store.appendEvent(
      createEvent(
        'run.failed',
        { error: 'Run failed because the provider disconnected.' },
        eventContext,
      ),
    );

    const beforeReload = buildThreadPresentation(store, created.thread.id);
    expect(beforeReload).toEqual({
      version: 1,
      threadId: created.thread.id,
      nextCursor: expect.any(Number),
      hasMore: false,
      messages: [
        expect.objectContaining({
          id: user.id,
          runId: run.id,
          role: 'user',
          markdown: 'Review the repository',
          status: 'completed',
          activities: [],
        }),
        expect.objectContaining({
          id: `run:${run.id}:assistant`,
          runId: run.id,
          role: 'assistant',
          markdown: '## Review\n\nThe run failed safely.',
          provider: { name: 'codex', model: 'gpt-test' },
          status: 'failed',
          error: {
            message: 'Run failed because the provider disconnected.',
            retryable: true,
          },
          activities: [
            expect.objectContaining({
              runId: run.id,
              status: 'failed',
              items: [
                expect.objectContaining({ id: 'tool-1', status: 'completed' }),
                expect.objectContaining({ id: 'tool-2', status: 'failed' }),
              ],
            }),
          ],
          artifacts: [
            {
              type: 'unsupported',
              sourceKind: 'future_block',
              label: 'Additional content is not supported in this NUAAI version.',
            },
          ],
        }),
      ],
    });
    expect(beforeReload.messages.map((message) => message.id)).not.toContain(intermediate.id);

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new DatabaseStore(openAppDatabase(root));
    stores.push(reopened);
    expect(buildThreadPresentation(reopened, created.thread.id)).toEqual(beforeReload);
  });

  it('synthesizes one stable streaming assistant response before a final message exists', async () => {
    const { store } = await createStore();
    const created = store.createSession('Streaming', 200);
    const run = store.createRun(
      created.thread.id,
      'Inspect files',
      'codex',
      'gpt-test',
      'presentation-streaming',
      210,
    );
    store.updateRun(run.id, { status: 'running' }, 211);
    const user = store.addMessage(
      created.thread.id,
      'user',
      'Inspect files',
      'codex',
      'gpt-test',
      212,
    );
    store.storeMessageArtifact(user.id, 'run_link', { runId: run.id }, 212);
    const context = {
      sessionId: created.session.id,
      threadId: created.thread.id,
      runId: run.id,
    };
    store.appendEvent(createEvent('run.started', {}, context));
    store.appendEvent(createEvent('model.delta', { text: 'Working' }, context));
    store.appendEvent(createEvent('model.delta', { text: ' safely.' }, context));

    const view = buildThreadPresentation(store, created.thread.id);
    expect(view.messages).toEqual([
      expect.objectContaining({ id: user.id, role: 'user' }),
      expect.objectContaining({
        id: `run:${run.id}:assistant`,
        runId: run.id,
        role: 'assistant',
        markdown: 'Working safely.',
        status: 'streaming',
        provider: { name: 'codex', model: 'gpt-test' },
      }),
    ]);
  });

  it('uses the durable run snapshot when a long active stream exceeds replay history', async () => {
    const { store } = await createStore();
    const created = store.createSession('Long streaming', 220);
    const run = store.createRun(
      created.thread.id,
      'Write a long report',
      'codex',
      'gpt-test',
      'presentation-long-streaming',
      221,
    );
    const snapshot = `Beginning ${'durable output '.repeat(1_500)}Final line.`;
    store.updateRun(run.id, { status: 'running', output: snapshot }, 222);
    const user = store.addMessage(
      created.thread.id,
      'user',
      'Write a long report',
      'codex',
      'gpt-test',
      223,
    );
    store.storeMessageArtifact(user.id, 'run_link', { runId: run.id }, 223);
    const context = {
      sessionId: created.session.id,
      threadId: created.thread.id,
      runId: run.id,
    };
    store.appendEvent(createEvent('run.started', {}, context));
    store.appendEvent(
      createEvent(
        'tool.started',
        { id: 'early-tool', name: 'workspace.read', arguments: { path: 'src/core/runtime.ts' } },
        context,
      ),
    );
    store.appendEvent(
      createEvent(
        'tool.completed',
        { id: 'early-tool', name: 'workspace.read', result: { bytes: 42 } },
        context,
      ),
    );
    for (let index = 0; index < 400; index += 1)
      store.appendEvent(createEvent('model.delta', { text: String(index % 10) }, context));

    const view = buildThreadPresentation(store, created.thread.id);
    expect(view.messages).toEqual([
      expect.objectContaining({ id: user.id, role: 'user' }),
      expect.objectContaining({
        id: `run:${run.id}:assistant`,
        markdown: snapshot,
        status: 'streaming',
        activities: [
          expect.objectContaining({
            items: [expect.objectContaining({ id: 'early-tool', status: 'completed' })],
          }),
        ],
      }),
    ]);
  });

  it('paginates structured message views without losing the older-history cursor', async () => {
    const { store } = await createStore();
    const created = store.createSession('Presentation pages', 300);
    for (let index = 0; index < 3; index += 1)
      store.addMessage(created.thread.id, 'user', `page-${index}`, undefined, undefined, 301);

    const newest = buildThreadPresentation(store, created.thread.id, { limit: 2 });
    expect(newest.messages.map((message) => message.markdown)).toEqual(['page-1', 'page-2']);
    expect(newest.hasMore).toBe(true);
    const oldest = buildThreadPresentation(store, created.thread.id, {
      before: newest.nextCursor,
      limit: 2,
    });
    expect(oldest.messages.map((message) => message.markdown)).toEqual(['page-0']);
    expect(oldest.hasMore).toBe(false);
  });
});
