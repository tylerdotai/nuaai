import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it.each([
  'allow',
  'deny',
  'ask',
  'malformed',
  'error',
  'tool-call',
  'oversized-result',
  'oversized-proposal',
  'timeout',
  'cancel',
] as const)(
  'Smart performs a separate tool-free review and handles %s without guessing',
  async (verdict) => {
    const h = await identityHarness();
    let reviews = 0;
    vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
      if (request.systemPrompt?.startsWith('NUAAI approval reviewer')) {
        reviews++;
        expect(request.tools ?? []).toEqual([]);
        expect(request.dynamicTools ?? []).toEqual([]);
        if (verdict === 'error') throw new Error('Fixture reviewer unavailable');
        if (verdict === 'timeout' || verdict === 'cancel')
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => reject(new Error('Fixture review aborted')),
              { once: true },
            );
          });
        if (verdict === 'tool-call') {
          yield {
            type: 'tool_call',
            id: 'forbidden',
            name: 'workspace.write',
            arguments: { path: 'should-not-exist.txt', content: 'no' },
          };
          return;
        }
        if (verdict === 'oversized-result') {
          yield { type: 'delta', text: 'x'.repeat(5000) };
          return;
        }
        yield {
          type: 'done',
          text:
            verdict === 'malformed'
              ? 'Not a structured verdict'
              : JSON.stringify({ decision: verdict, reason: 'Fixture review' }),
        };
        return;
      }
      const lastUser = request.messages
        .map((m) => m.role === 'user' && m.content.startsWith('Store SMART'))
        .lastIndexOf(true);
      const results = request.messages.slice(lastUser + 1).filter((m) => m.role === 'tool');
      if (!results.length)
        yield {
          type: 'tool_call',
          id: 'store',
          name: 'memory.store',
          arguments: {
            content: 'SMART_REVIEW_SENTINEL',
            ...(verdict === 'oversized-proposal'
              ? { metadata: { padding: 'x'.repeat(15000) } }
              : {}),
          },
        };
      else if (results.length === 1)
        yield {
          type: 'tool_call',
          id: 'search',
          name: 'memory.search',
          arguments: { query: 'SMART_REVIEW_SENTINEL' },
        };
      else
        yield {
          type: 'done',
          text:
            verdict === 'deny'
              ? 'The requested storage was blocked.'
              : 'Memory stored and searched.',
        };
    });
    try {
      const session = h.daemon.runtime.createSession('Smart', 'test:smart', undefined, {
        workspaceRoot: h.project,
      });
      await h.api(`/api/sessions/${session.session.id}/permissions`, { mode: 'smart' });
      const accepted = await h.api('/api/runs', {
        threadId: session.thread.id,
        input: 'Store SMART_REVIEW_SENTINEL and search it.',
      });
      if (verdict !== 'oversized-proposal') await expect.poll(() => reviews).toBe(1);
      if (verdict === 'cancel') h.daemon.runtime.cancelRun(accepted.body.id);
      else if (!['allow', 'deny'].includes(verdict)) {
        await expect
          .poll(() => h.daemon.runtime.listApprovals('pending').length, { timeout: 25000 })
          .toBe(1);
        expect(JSON.stringify((await h.api('/api/memory')).body)).not.toContain(
          'SMART_REVIEW_SENTINEL',
        );
        const approval = h.daemon.runtime.listApprovals('pending')[0];
        await h.api(`/api/approvals/${approval.id}/approve`, { payloadHash: approval.payloadHash });
      }
      const result = await h.daemon.runtime.waitForRun(accepted.body.id);
      expect(result.status).toBe(
        verdict === 'deny' ? 'failed' : verdict === 'cancel' ? 'cancelled' : 'completed',
      );
      const memories = JSON.stringify((await h.api('/api/memory')).body);
      expect(memories.includes('SMART_REVIEW_SENTINEL')).toBe(
        !['deny', 'cancel'].includes(verdict),
      );
    } finally {
      await h.close();
    }
  },
  35000,
);
