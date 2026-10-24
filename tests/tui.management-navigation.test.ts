import { expect, it } from 'vitest';
import { realTuiHarness } from './tui.real-harness.js';

it('keeps the automation editor separate from the composer and permits repeated in-menu changes with one-level Escape', async () => {
  const h = await realTuiHarness();
  try {
    const created = await h.api('/api/schedules', {
      name: 'Persistent menu automation',
      type: 'manual',
      expression: 'manual',
      agentInput: 'Fixture only; no tools.',
      enabled: true,
    });
    expect(created.status).toBe(200);
    await h.send('KEEP_AUTOMATION_DRAFT', 'KEEP_AUTOMATION_DRAFT');
    await h.send('\u001bc', 'Automations');
    await h.send('Persistent menu automation');
    await h.send('\r', 'Pause automation');
    await h.send('Edit automation');
    await h.send('\r', 'Automation name');
    expect(h.frame()).toContain('Persistent menu automation');
    await h.send('\u001b', 'Edit automation');
    expect(h.frame()).toContain('Search: Edit automation');
    await h.send('\u0015');
    await h.send('\u001b[B', 'Pause automation');
    await h.send('\r', 'Schedule paused');
    expect(h.frame()).toContain('Resume automation');
    expect((await h.api('/api/schedules')).body.schedules[0].enabled).toBe(false);
    await h.send('\r', 'Schedule resumed');
    expect(h.frame()).toContain('Pause automation');
    expect((await h.api('/api/schedules')).body.schedules[0].enabled).toBe(true);
    await h.send('\u001b', 'Automations');
    expect(h.frame()).toContain('Search: Persistent menu automation');
    await h.send('\u001b', 'KEEP_AUTOMATION_DRAFT');
  } finally {
    await h.close();
  }
}, 15_000);
