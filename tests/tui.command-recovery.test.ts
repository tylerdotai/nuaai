import { expect, it, vi } from 'vitest';
import { realTuiHarness } from './tui.real-harness.js';

it('keeps a rejected skill-creation command intact for deliberate retry and persists one actual skill', async () => {
  const h = await realTuiHarness();
  const nativeFetch = globalThis.fetch;
  let reject = true;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (reject && String(url).endsWith('/api/skills') && options?.method === 'POST') {
      return new Response(JSON.stringify({ error: 'Skill service temporarily unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return nativeFetch(url, options);
  });
  const command =
    '/skill-create recovered-guide|Keep the complete instructions for a deliberate retry.';
  try {
    await h.send(command, command);
    await h.send('\r', 'Skill service temporarily unavailable');
    expect(h.frame()).toContain(`› ${command}`);
    expect((await h.api('/api/skills/recovered-guide')).status).toBe(404);
    reject = false;
    await h.send('\r', 'Skill created · recovered-guide');
    expect((await h.api('/api/skills/recovered-guide')).body.instructions).toContain(
      'Keep the complete instructions for a deliberate retry.',
    );
    expect(
      (await h.api('/api/skills')).body.skills
        .filter((skill: { name: string }) => skill.name.startsWith('recovered-guide'))
        .map((skill: { name: string }) => skill.name),
    ).toEqual(['recovered-guide']);
    expect(h.frame()).not.toContain(`› ${command}`);
  } finally {
    fetch.mockRestore();
    await h.close();
  }
});
