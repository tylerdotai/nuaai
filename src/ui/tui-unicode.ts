const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(text: string) {
  return Array.from(segmenter.segment(text));
}

/** Cursor offsets stay UTF-16 offsets, but must always land on a grapheme boundary. */
export function graphemeCursor(text: string, cursor: number): number {
  const bounded = Math.max(0, Math.min(text.length, cursor));
  if (bounded === text.length) return bounded;
  return graphemes(text).reduce(
    (position, item) => (item.index <= bounded ? item.index : position),
    0,
  );
}

/** Conventional terminal cells: emoji presentation is wide; marks/format controls are zero. */
export function graphemeCells(text: string): number {
  if (/\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20e3|\uFE0F/u.test(text)) return 2;
  let cells = 0;
  for (const character of text) {
    if (/[\p{Mark}\p{Cf}\p{Cc}]/u.test(character)) continue;
    const code = character.codePointAt(0) ?? 0;
    const wide =
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff01 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x16fe0 && code <= 0x18dff) ||
        (code >= 0x1aff0 && code <= 0x1afff) ||
        (code >= 0x1b000 && code <= 0x1b2ff) ||
        (code >= 0x20000 && code <= 0x3fffd));
    cells += wide ? 2 : 1;
  }
  return cells;
}

export function terminalCells(text: string): number {
  return graphemes(text).reduce((width, item) => width + graphemeCells(item.segment), 0);
}
