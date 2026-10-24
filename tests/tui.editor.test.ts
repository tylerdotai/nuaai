import { renderToString } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { TuiEditor, layoutDraft } from '../src/ui/tui-editor.js';

it('wraps drafts by terminal cells and preserves source cursor positions', () => {
  expect(layoutDraft('ab😀cd\nend', 4)).toEqual([
    { text: 'ab😀', start: 0, end: 4 },
    { text: 'cd', start: 4, end: 6 },
    { text: 'end', start: 7, end: 10 },
  ]);
});
it('keeps the cursor region visible in a large pasted draft and when moving back to the start', () => {
  const input = `${'long draft '.repeat(40)}\nTAIL`;
  const latest = renderToString(
    createElement(TuiEditor, { input, cursor: input.length, columns: 40, maxRows: 3 }),
    { columns: 44 },
  );
  expect(latest).toContain('TAIL');
  expect(latest.trim().split('\n').length).toBeLessThanOrEqual(5);
  const start = renderToString(
    createElement(TuiEditor, { input: `START${input}`, cursor: 0, columns: 40, maxRows: 3 }),
    { columns: 44 },
  );
  expect(start).toContain('START');
  expect(start).not.toContain('TAIL');
});
