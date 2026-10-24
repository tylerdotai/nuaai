import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it.each(['cancel', 'deadline'] as const)(
  'releases a noncooperative model on %s and discards its eventual tool output',
  async (boundary) => {
    const h = await identityHarness(undefined, (config) => {
      if (boundary === 'deadline') config.limits.providerTimeoutMs = 250;
    });
    let release = () => {};
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    let lateProduced = false;
    let calls = 0;
    vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* () {
      calls += 1;
      if (calls === 1) {
        entered = true;
        await stuck;
        lateProduced = true;
        yield {
          type: 'tool_call',
          id: 'late-model-write',
          name: 'workspace.write',
          arguments: {
            path: 'late-model-output.txt',
            content: 'This late output must never execute.',
          },
        };
      } else yield { type: 'done', text: 'Ready.' };
    });
    try {
      const created = h.daemon.runtime.createSession(
        'Noncooperative model',
        'model-abort-boundary',
        undefined,
        { workspaceRoot: h.project },
      );
      const first = await h.api('/api/runs', {
        threadId: created.thread.id,
        input: 'Hold this response.',
      });
      await expect.poll(() => entered).toBe(true);
      if (boundary === 'cancel')
        expect((await h.api(`/api/runs/${first.body.id}/cancel`, {})).status).toBe(200);
      const next = await h.api('/api/runs', { threadId: created.thread.id, input: 'Say ready.' });
      await expect
        .poll(async () => (await h.api(`/api/runs/${next.body.id}`)).body.status, { timeout: 1500 })
        .toBe('completed');
      const terminal = (await h.api(`/api/runs/${first.body.id}`)).body;
      expect(terminal.status).toBe(boundary === 'cancel' ? 'cancelled' : 'failed');
      if (boundary === 'deadline')
        expect(terminal.output).toContain('Model response timed out after 250ms');
      release();
      await expect.poll(() => lateProduced).toBe(true);
      expect(
        h.daemon.store
          .listRecentEventsForRun(first.body.id, 100)
          .filter((event) => event.type === 'tool.started'),
      ).toEqual([]);
      await expect(access(join(h.project, 'late-model-output.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      release();
      await h.close();
    }
  },
  15_000,
);
