import { expect, it } from 'vitest';
import { realTuiHarness } from './tui.real-harness.js';

it('changes learning through Settings with verified state and returns one menu level without losing the selection', async () => {
  const h = await realTuiHarness();
  try {
    await h.command('/settings', 'Settings');
    await h.send('Agent learning');
    await h.send('\r', 'Current: automatic');
    await h.send('Manual');
    await h.send('\r', 'Agent learning · manual');
    expect(h.frame()).toContain('Current: manual');
    expect(h.frame()).toContain('Search: Manual');
    expect((await h.api('/api/memory/learning')).body).toMatchObject({
      mode: 'manual',
      enabled: false,
    });
    await h.send('\u001b', 'Settings');
    expect(h.frame()).toContain('Agent learning · manual');
    expect(h.frame()).toContain('Search: Agent learning');
  } finally {
    await h.close();
  }
}, 15_000);
