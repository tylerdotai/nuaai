import { expect, it } from 'vitest';
import { editDraft } from '../src/ui/tui-commands.js';
import { graphemes, terminalCells } from '../src/ui/tui-unicode.js';

it('keeps vertical movement on grapheme boundaries at the same visual cell column', () => {
  expect(editDraft({ text: '界x\nabc', cursor: 1 }, '', { downArrow: true }).cursor).toBe(5);
  expect(editDraft({ text: '界x\nabc', cursor: 2 }, '', { downArrow: true }).cursor).toBe(6);
});
it('never returns an interior cursor when inserted text joins the following grapheme', () => {
  const result = editDraft({ text: '👩', cursor: 0 }, '👩‍', {});
  expect([0, ...graphemes(result.text).map((item) => item.index + item.segment.length)]).toContain(
    result.cursor,
  );
});
it('uses two cells for supplementary East Asian scripts and zero for formatting marks', () => {
  expect(terminalCells('𗀀')).toBe(2);
  expect(terminalCells('\u200d')).toBe(0);
});
