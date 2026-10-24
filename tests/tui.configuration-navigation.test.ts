import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { realTuiHarness } from './tui.real-harness.js';

it('keeps model, permission and skill changes inside their menus and reads saved state before presenting success', async () => {
  const health = vi.spyOn(DeterministicProvider.prototype, 'health').mockResolvedValue({
    name: 'deterministic',
    available: true,
    detail: 'Isolated menu fixture',
    models: ['local-test'],
  });
  const h = await realTuiHarness();
  try {
    await h.command('/model', 'Choose model');
    await h.send('\r', 'Model saved');
    expect(h.frame()).toContain('Choose model');
    expect(h.frame()).toContain('current');
    await h.command('/permissions', 'Approval mode');
    await h.send('Smart');
    await h.send('\r', 'Approval mode · smart');
    expect(h.frame()).toContain('Current: smart');
    expect(h.frame()).toContain('Search: Smart');
    const created = await h.api('/api/skills', {
      name: 'navigation-proof',
      instructions: 'Use only as an isolated menu persistence fixture.',
    });
    expect(created.status).toBe(200);
    await h.command('/skills', 'Skills · select to toggle');
    await h.send('navigation-proof');
    await h.send('\r', 'navigation-proof: disable applied');
    expect(h.frame()).toContain('Skills · select to toggle');
    expect(h.frame()).toContain('navigation-proof · disabled');
    expect(
      (await h.api('/api/skills')).body.skills.find(
        (entry: { name: string }) => entry.name === 'navigation-proof',
      ).enabled,
    ).toBe(false);
    await h.send('\r', 'navigation-proof: enable applied');
    expect(h.frame()).toContain('navigation-proof · enabled');
    expect(
      (await h.api('/api/skills')).body.skills.find(
        (entry: { name: string }) => entry.name === 'navigation-proof',
      ).enabled,
    ).toBe(true);
  } finally {
    await h.close();
    health.mockRestore();
  }
}, 15_000);
