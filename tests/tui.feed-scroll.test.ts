import { expect, it } from 'vitest';
import { workflowHarness } from './tui.workflow-harness.js';

it('scrolls the transcript instead of recalling sent input, including terminal wheel sequences, without changing a draft', async () => {
  for (const key of ['\u001b[A', '\u001b[<64;20;10M', '\u001b[5~']) {
    const ui = await workflowHarness({
      a: [
        {
          id: 'long',
          role: 'assistant',
          markdown: Array.from(
            { length: 100 },
            (_, i) => `FEED_LINE_${String(i).padStart(3, '0')}`,
          ).join('\n'),
        },
      ],
    });
    try {
      await expect.poll(ui.frame).toContain('FEED_LINE_099');
      await ui.send('OLD_SENT_INPUT');
      await ui.send('\r', 'Run accepted');
      await ui.send('KEEP_THIS_DRAFT', 'KEEP_THIS_DRAFT');
      const lastLine = () =>
        Math.max(...[...ui.frame().matchAll(/FEED_LINE_(\d+)/g)].map((match) => Number(match[1])));
      const before = lastLine();
      await ui.send(key);
      await expect.poll(lastLine, { timeout: 1000 }).toBeLessThan(before);
      expect(ui.frame()).toContain('KEEP_THIS_DRAFT');
      await ui.send('\u001b[1;5F');
      await expect.poll(ui.frame).toContain('FEED_LINE_099');
      await ui.send('\r', 'Run accepted');
      await expect
        .poll(
          () =>
            ui.requests
              .filter((request) => request.path === '/api/runs' && request.method === 'POST')
              .at(-1)?.body.input,
        )
        .toBe('KEEP_THIS_DRAFT');
    } finally {
      await ui.close();
    }
  }
});
