import { Box, Text } from 'ink';
import { terminalText } from './tui-markdown.js';
import { graphemeCells, graphemeCursor, graphemes } from './tui-unicode.js';

interface DraftRow {
  text: string;
  start: number;
  end: number;
}

export function layoutDraft(input: string, columns: number): DraftRow[] {
  const rows: DraftRow[] = [];
  let start = 0;
  let text = '';
  let width = 0;
  for (const { segment, index } of graphemes(input)) {
    if (segment === '\n') {
      rows.push({ text, start, end: index });
      start = index + 1;
      text = '';
      width = 0;
      continue;
    }
    const cells = graphemeCells(segment);
    if (width + cells > Math.max(1, columns) && text) {
      rows.push({ text, start, end: index });
      start = index;
      text = '';
      width = 0;
    }
    text += cells > Math.max(1, columns) ? '�' : segment;
    width += cells;
  }
  rows.push({ text, start, end: input.length });
  if (width >= columns) rows.push({ text: '', start: input.length, end: input.length });
  return rows;
}

export function TuiEditor({
  input,
  cursor,
  columns,
  maxRows = 5,
}: { input: string; cursor: number; columns: number; maxRows?: number }): React.JSX.Element {
  cursor = graphemeCursor(input, cursor);
  maxRows = Math.max(1, Math.floor(maxRows));
  const rows = layoutDraft(input, Math.max(1, columns - 6));
  const cursorRow = Math.max(
    0,
    rows.reduce((selected, row, index) => (row.start <= cursor ? index : selected), 0),
  );
  const start = Math.max(0, cursorRow - maxRows + 1);
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="blue"
      paddingX={1}
      width={columns}
      flexShrink={0}
    >
      {rows.slice(start, start + maxRows).map((row, index) => {
        const selected = start + index === cursorRow;
        const position = cursor - row.start;
        const character = selected ? (graphemes(row.text.slice(position))[0]?.segment ?? ' ') : '';
        return (
          <Text key={`${row.start}-${row.end}`}>
            <Text color="blue">{start + index === 0 ? '› ' : '  '}</Text>
            {selected ? (
              <>
                {terminalText(row.text.slice(0, position))}
                <Text inverse>{character}</Text>
                {terminalText(
                  row.text.slice(
                    position +
                      (character === ' ' && position === row.text.length ? 0 : character.length),
                  ),
                )}
              </>
            ) : (
              terminalText(row.text) || ' '
            )}
          </Text>
        );
      })}
    </Box>
  );
}
