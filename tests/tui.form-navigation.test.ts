import { expect, it } from 'vitest';
import { realTuiHarness } from './tui.real-harness.js';

it('returns a saved automation to its editor and updates the same record on a second save', async () => {
  const h = await realTuiHarness();
  try {
    await h.command('/schedule', 'Automation name');
    await h.send('Editor continuity');
    await h.send('\r', 'Schedule type');
    await h.send('\r', 'Schedule expression');
    await h.send('\r', 'Agent instructions');
    await h.send('Fixture instructions.');
    await h.send('\r', 'Review automation');
    await h.send('\u001b[B');
    await h.send('\r', 'Automation saved and verified');
    expect(h.frame()).toContain('Agent instructions');
    expect(h.frame()).toContain('Fixture instructions.');
    const first = (await h.api('/api/schedules')).body.schedules;
    expect(first).toHaveLength(1);
    await h.send(' Updated.');
    await h.send('\r', 'Review automation');
    await h.send('\u001b[B');
    await h.send('\r', 'Automation saved and verified');
    const second = (await h.api('/api/schedules')).body.schedules;
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].agentInput).toBe('Fixture instructions. Updated.');
  } finally {
    await h.close();
  }
}, 15_000);
