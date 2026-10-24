import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('accepts relevant successful skill search/load evidence when the request chains tool invocations with then', async () => {
  const h = await identityHarness();
  const provider = vi
    .spyOn(DeterministicProvider.prototype, 'stream')
    .mockImplementation(async function* (request) {
      if (!request.messages.some((m) => m.toolName === 'skill.search'))
        yield {
          type: 'tool_call' as const,
          id: 'search',
          name: 'skill.search',
          arguments: { query: 'acceptance-live-guide' },
        };
      else if (!request.messages.some((m) => m.toolName === 'skill.load'))
        yield {
          type: 'tool_call' as const,
          id: 'load',
          name: 'skill.load',
          arguments: { name: 'acceptance-live-guide' },
        };
      else yield { type: 'done' as const, text: 'The recorded sentinel is amber-lake-614.' };
    });
  try {
    expect(
      (
        await h.api('/api/skills', {
          name: 'acceptance-live-guide',
          instructions: 'Packing sentinel: amber-lake-614.',
        })
      ).status,
    ).toBe(200);
    const created = await h.api('/api/sessions', {});
    const run = await h.api('/api/runs', {
      threadId: created.body.thread.id,
      input:
        'Call skill.search for acceptance-live-guide, then skill.load for the matching skill. What exact packing sentinel is recorded? Report only what the loaded instructions contain.',
    });
    const result = await h.daemon.runtime.waitForRun(run.body.id);
    expect(result.status, result.output).toBe('completed');
    expect(result.output).toContain('amber-lake-614');
  } finally {
    provider.mockRestore();
    await h.close();
  }
}, 15000);
