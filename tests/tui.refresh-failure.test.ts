import { expect, it, vi } from 'vitest';
import { realTuiHarness } from './tui.real-harness.js';

it('never reports a successful refresh when the conversation snapshot request fails', async () => {
  const h = await realTuiHarness();
  const nativeFetch = globalThis.fetch;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url).endsWith('/api/sessions')) {
      return new Response(
        JSON.stringify({ error: 'Conversation snapshot temporarily unavailable' }),
        {
          status: 503,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return nativeFetch(url, options);
  });
  try {
    await h.command('/refresh', 'Conversation snapshot temporarily unavailable');
    expect(h.frame()).not.toContain('Runtime refreshed');
    expect(h.frame()).toContain('› /refresh');
  } finally {
    fetch.mockRestore();
    await h.close();
  }
});
