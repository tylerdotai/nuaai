import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it.each(['cancel', 'deadline'] as const)(
  'releases a noncooperative tool on %s without retrying its real effect or claiming that it stopped',
  async (boundary) => {
    const h = await identityHarness(undefined, (config) => {
      if (boundary === 'deadline') config.limits.toolTimeoutMs = 250;
    });
    let release = () => {};
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    let finished = false;
    let calls = 0;
    // Use the daemon's concrete registry for fixture setup; do not mock admission or execution.
    // biome-ignore lint/complexity/useLiteralKeys: Indexed access keeps TypeScript checking the private test-fixture dependency without adding a production-only-for-tests API.
    h.daemon.runtime['options'].tools.register({
      name: 'counter.blocked_append',
      permission: 'write',
      description: 'Isolated fixture: append once, then deliberately ignore abort.',
      governance: {
        owner: 'counter',
        costClass: 'low',
        authMode: 'none',
        sideEffects: 'workspace',
        approval: 'profile',
        maxCallsPerRun: 4,
      },
      parameters: { type: 'object', properties: {} },
      input: z.object({}),
      execute: async () => {
        await appendFile(join(h.project, 'effect.txt'), 'once\n');
        entered = true;
        await stuck;
        finished = true;
        return { ok: true };
      },
    });
    vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* () {
      calls += 1;
      if (calls === 1)
        yield {
          type: 'tool_call',
          id: 'blocked-effect',
          name: 'counter.blocked_append',
          arguments: {},
        };
      else yield { type: 'done', text: 'Ready.' };
    });
    try {
      const created = h.daemon.runtime.createSession(
        'Noncooperative tool',
        'tool-abort-boundary',
        undefined,
        { workspaceRoot: h.project },
      );
      expect(
        (
          await h.api(`/api/sessions/${created.session.id}/permissions`, {
            mode: 'unguarded',
            confirmUnguarded: true,
          })
        ).status,
      ).toBe(200);
      const first = await h.api('/api/runs', {
        threadId: created.thread.id,
        input: 'Run the counter fixture once.',
      });
      await expect.poll(() => entered).toBe(true);
      if (boundary === 'cancel')
        expect((await h.api(`/api/runs/${first.body.id}/cancel`, {})).status).toBe(200);
      await expect
        .poll(async () => (await h.api(`/api/runs/${first.body.id}`)).body.status, {
          timeout: 1500,
        })
        .toBe(boundary === 'cancel' ? 'cancelled' : 'failed');
      const next = await h.api('/api/runs', { threadId: created.thread.id, input: 'Say ready.' });
      await expect
        .poll(async () => (await h.api(`/api/runs/${next.body.id}`)).body.status, { timeout: 1500 })
        .toBe('completed');
      const failure = h.daemon.store
        .listRecentEventsForRun(first.body.id, 100)
        .find((event) => event.type === 'tool.failed');
      expect(failure?.payload).toMatchObject({
        id: 'blocked-effect',
        failureCode: boundary === 'cancel' ? 'TOOL_INTERRUPTED' : 'TOOL_TIMEOUT',
        executionState: 'uncertain',
        recovery: 'inspect_destination',
      });
      expect(failure?.payload.error).toContain(boundary === 'cancel' ? 'Run cancelled' : '250ms');
      release();
      await expect.poll(() => finished).toBe(true);
      expect(await readFile(join(h.project, 'effect.txt'), 'utf8')).toBe('once\n');
      expect(
        h.daemon.store
          .listRecentEventsForRun(first.body.id, 100)
          .filter((event) => event.type === 'tool.completed'),
      ).toEqual([]);
    } finally {
      release();
      await h.close();
    }
  },
  15_000,
);
