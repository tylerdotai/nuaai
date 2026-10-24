import { expect, it } from 'vitest';
import { workflowHarness } from './tui.workflow-harness.js';

it('searches older pages and jumps between matching rendered turns without replacing the draft', async () => {
  const ui = await workflowHarness();
  try {
    ui.messages.a = [
      { id: 'old-hit', role: 'assistant', markdown: 'rare shipment FIRST' },
      { id: 'middle', role: 'assistant', markdown: 'filler\n'.repeat(45) },
      {
        id: 'new-hit',
        role: 'assistant',
        markdown: `rare shipment SECOND\n${'latest filler\n'.repeat(45)}`,
      },
    ];
    await expect.poll(ui.frame).toContain('Thread A');
    await ui.send('\u0012');
    await ui.send('keep draft', 'keep draft');
    await ui.send('\u001bz', 'Search conversation');
    await ui.send('rare shipment', '2 entries');
    await ui.send('\r', 'Match 1/2');
    await expect.poll(ui.frame).toContain('rare shipment FIRST');
    expect(ui.frame()).toContain('keep draft');
    expect(ui.frame()).toContain('Match 1/2');
    await ui.send('\u001bj', 'Match 2/2');
    expect(ui.frame()).toContain('rare shipment SECOND');
    await ui.send('\u001bv', 'Match 1/2');
    expect(ui.frame()).toContain('rare shipment FIRST');
    expect(ui.requests.some((request) => request.path.includes('before='))).toBe(true);
  } finally {
    await ui.close();
  }
});
