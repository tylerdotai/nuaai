import { expect, it } from 'vitest';
import { workflowHarness } from './tui.workflow-harness.js';

it('keeps a scrolled reading position stable when a live reply grows and resumes following only after an explicit jump', async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `ANCHOR_LINE_${String(i).padStart(3, '0')}`);
  const ui = await workflowHarness({
    a: [{ id: 'growing', role: 'assistant', markdown: lines.join('\n') }],
  });
  const visible = () =>
    [...ui.frame().matchAll(/ANCHOR_LINE_(\d+)/g)].map((match) => Number(match[1]));
  try {
    await expect.poll(ui.frame).toContain('ANCHOR_LINE_099');
    await ui.send('\u0012', 'Runtime refreshed');
    await ui.send('PRESERVED_DRAFT');
    await ui.send('\u001b[5~');
    const before = visible();
    expect(before.length).toBeGreaterThan(5);
    expect(before).not.toContain(99);
    ui.messages.a[0].markdown += `\n${Array.from({ length: 12 }, (_, i) => `APPENDED_LINE_${i}`).join('\n')}`;
    await ui.send('\u0012', 'Runtime refreshed');
    await expect.poll(visible).toEqual(before);
    expect(ui.frame()).toContain('PRESERVED_DRAFT');
    await ui.send('\u001b[1;5F');
    await expect.poll(ui.frame).toContain('APPENDED_LINE_11');
  } finally {
    await ui.close();
  }
});
