import { renderToString } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { editDraft } from '../src/ui/tui-commands.js';
import { TuiEditor, layoutDraft } from '../src/ui/tui-editor.js';

it('moves and deletes whole combining, joined emoji, flag, and keycap graphemes', () => {
  for (const glyph of ['e\u0301', '👩‍💻', '🇺🇸', '1️⃣', '界']) {
    const text = `a${glyph}z`;
    const cursor = 1 + glyph.length;
    expect(editDraft({ text, cursor }, '', { leftArrow: true }).cursor).toBe(1);
    expect(editDraft({ text, cursor: 1 }, '', { rightArrow: true }).cursor).toBe(cursor);
    expect(editDraft({ text, cursor }, '', { backspace: true })).toEqual({ text: 'az', cursor: 1 });
    expect(editDraft({ text, cursor: 1 }, '', { delete: true })).toEqual({ text: 'az', cursor: 1 });
  }
});
it('wraps flags, emoji presentation, keycaps and CJK by terminal cells', () => {
  for (const glyph of ['🇺🇸', '👩‍💻', '1️⃣', '❤️', '界']) {
    expect(layoutDraft(`${glyph}x`, 2).map((row) => row.text)).toEqual([glyph, 'x']);
  }
  expect(layoutDraft('e\u0301x', 2).map((row) => row.text)).toEqual(['e\u0301x', '']);
});
it('highlights the whole grapheme without duplicating or splitting it', () => {
  const output = renderToString(
    createElement(TuiEditor, { input: 'a👩‍💻z', cursor: 1, columns: 30 }),
  );
  expect(output).toContain('a👩‍💻z');
});
