import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('reports completed after an approved memory.forget and real search readback instead of rejecting successful deletion', async () => {
  const h = await identityHarness();
  let target = '';
  const provider = vi
    .spyOn(DeterministicProvider.prototype, 'stream')
    .mockImplementation(async function* (request) {
      if (!request.messages.some((m) => m.toolName === 'memory.forget'))
        yield {
          type: 'tool_call' as const,
          id: 'forget',
          name: 'memory.forget',
          arguments: { id: target },
        };
      else if (!request.messages.some((m) => m.toolName === 'memory.search'))
        yield {
          type: 'tool_call' as const,
          id: 'search',
          name: 'memory.search',
          arguments: { query: 'ACCEPTANCE_PART_CODE' },
        };
      else
        yield {
          type: 'done' as const,
          text: 'The target memory was removed; search confirms it is absent.',
        };
    });
  try {
    await h.api('/api/memory', { content: 'ACCEPTANCE_PART_CODE is copper-elm-482.' });
    target = (await h.api('/api/memory')).body.memories[0].id;
    const created = await h.api('/api/sessions', {});
    const accepted = await h.api('/api/runs', {
      threadId: created.body.thread.id,
      input: `Use memory.forget to delete only memory ${target}. Then use memory.search for ACCEPTANCE_PART_CODE to verify that record was removed. Do not delete any other record.`,
    });
    await expect.poll(() => h.daemon.store.getRun(accepted.body.id)?.status).toBe('paused');
    const approval = (await h.api('/api/approvals')).body.approvals.find(
      (a: { runId: string }) => a.runId === accepted.body.id,
    );
    expect(
      (await h.api(`/api/approvals/${approval.id}/approve`, { payloadHash: approval.payloadHash }))
        .status,
    ).toBe(200);
    const result = await h.daemon.runtime.waitForRun(accepted.body.id);
    expect(result.status, result.output).toBe('completed');
    expect(
      (await h.api('/api/memory')).body.memories.some((m: { id: string }) => m.id === target),
    ).toBe(false);
  } finally {
    provider.mockRestore();
    await h.close();
  }
}, 15000);
