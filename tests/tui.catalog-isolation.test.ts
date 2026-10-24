import { expect, it, vi } from 'vitest';
import { realTuiHarness } from './tui.real-harness.js';

it('opens fresh memory results and releases command input while an unrelated provider response is held', async () => {
  const h = await realTuiHarness();
  await h.api('/api/memory', { content: 'CAPABILITY_ISOLATION_MEMORY_SENTINEL' });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nativeFetch = globalThis.fetch;
  let held = false;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const response = await nativeFetch(url, options);
    if (String(url).endsWith('/api/providers')) {
      held = true;
      await gate;
    }
    return response;
  });
  try {
    await h.send('/memory', '/memory');
    await h.send('\r');
    await expect.poll(() => held).toBe(true);
    await expect.poll(h.frame).toContain('Search memories');
    expect(h.frame()).toContain('CAPABILITY_ISOLATION_MEMORY_SENTINEL');
    expect(h.frame()).not.toContain('Applying…');
    await h.send('\u001b');
    await h.command('/cancel', 'No active run in this thread.');
  } finally {
    release();
    fetch.mockRestore();
    await h.close();
  }
});
