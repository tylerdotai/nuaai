import { Box, Text } from 'ink';
import { terminalText } from './tui-markdown.js';
import { TuiViewport } from './tui-viewport.js';

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
}
export interface PickerState {
  title: string;
  items: PickerItem[];
  query: string;
  index: number;
  detail?: string[];
  detailOffset?: number;
}

export function pickerMatches(picker: PickerState): PickerItem[] {
  const query = picker.query.toLowerCase();
  return picker.items.filter((item) =>
    `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(query),
  );
}

export function TuiPicker({
  picker,
  busy,
  height = 16,
  onDetailExtent,
}: {
  picker: PickerState;
  busy: boolean;
  height?: number;
  onDetailExtent?: (maximum: number) => void;
}): React.JSX.Element {
  const items = pickerMatches(picker);
  const index = Math.min(picker.index, Math.max(0, items.length - 1));
  const detailRows = picker.detail?.length
    ? Math.min(5, Math.max(1, Math.floor((height - 7) / 2)))
    : 0;
  const capacity = Math.max(1, Math.min(8, height - 7 - detailRows));
  const start = Math.max(0, index - capacity + 1);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      marginTop={1}
      height={Math.max(0, height - 1)}
      overflow="hidden"
      flexShrink={0}
    >
      <Text bold wrap="truncate-end">
        {picker.title}
      </Text>
      {detailRows > 0 && (
        <TuiViewport
          height={detailRows}
          offset={picker.detailOffset ?? 0}
          anchor="start"
          onExtent={onDetailExtent}
        >
          {picker.detail?.map((line, i) => (
            <Text key={`${i}-${line}`}>{terminalText(line)}</Text>
          ))}
        </TuiViewport>
      )}
      <Text dimColor wrap="truncate-start">
        Search: {terminalText(picker.query) || 'type to filter…'}
      </Text>
      {items.length === 0 && <Text dimColor>No matching entries.</Text>}
      {items.slice(start, start + capacity).map((item, i) => (
        <Text
          key={item.id}
          wrap="truncate-end"
          color={start + i === index ? 'blue' : undefined}
          bold={start + i === index}
          dimColor={item.disabled}
        >
          {start + i === index ? '› ' : '  '}
          {terminalText(item.label).replaceAll('\n', ' ')}
          {item.disabled ? ' [unavailable]' : ''}
        </Text>
      ))}
      {items[index]?.detail && (
        <Text dimColor wrap="truncate-end">
          {terminalText(items[index].detail ?? '').replaceAll('\n', ' ')}
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {busy ? 'Applying…' : '↑↓ choose · Enter select · Esc back'} · {items.length} entries
        {detailRows ? ' · PgUp/PgDn details' : ''}
      </Text>
    </Box>
  );
}
