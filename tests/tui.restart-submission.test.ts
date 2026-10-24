import { expect, it, vi } from 'vitest';
import { realTuiHarness } from './tui.real-harness.js';

it('retains the pending submission identity across an actual TUI restart after an accepted response is lost', async () => {
  const h = await realTuiHarness();
  const nativeFetch = globalThis.fetch;
  const accepted: string[] = [];
  let drop = true;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const response = await nativeFetch(url, options);
    if (String(url).endsWith('/api/runs') && options?.method === 'POST') {
      accepted.push((await response.clone().json()).id);
      if (drop) {
        drop = false;
        await response.arrayBuffer();
        throw new TypeError('Controlled accepted response loss');
      }
    }
    return response;
  });
  const input = 'TUI_RESTART_SUBMISSION_SENTINEL';
  try {
    await h.send(input, input);
    await h.send('\r', 'Run acceptance uncertain');
    await h.relaunch();
    expect(h.frame()).toContain(`› ${input}`);
    await h.send('\r', 'Run accepted');
    expect(accepted).toEqual([accepted[0], accepted[0]]);
    const threadId = h.daemon.store.getRun(accepted[0])?.threadId;
    if (!threadId) throw new Error('Accepted run has no durable thread');
    expect(h.daemon.store.listRuns(threadId).map((run) => run.input)).toEqual([input]);
    expect(
      h.daemon.store
        .listMessages(threadId)
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual([input]);
  } finally {
    fetch.mockRestore();
    await h.close();
  }
});
