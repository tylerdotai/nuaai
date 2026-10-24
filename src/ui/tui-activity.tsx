import { Box, Text } from 'ink';
import { terminalText } from './tui-markdown.js';
import type { TuiApproval, TuiToolActivity } from './tui-state.js';
import { TuiViewport } from './tui-viewport.js';

export function TuiToolList({
  tools,
  expanded,
}: { tools: TuiToolActivity[]; expanded: boolean }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={tools.length ? 1 : 0}>
      {tools.map((tool, index) => (
        <Box key={tool.id ?? `${index}-${tool.name}`} flexDirection="column">
          <Text
            color={tool.status === 'failed' ? 'red' : tool.status === 'running' ? 'blue' : 'green'}
          >
            ↳ {terminalText(tool.name)} · {tool.status}
            {tool.target ? ` · ${terminalText(tool.target)}` : ''}
          </Text>
          {(expanded || tool.status === 'failed') && tool.detail && (
            <Text dimColor> {terminalText(tool.detail).slice(0, 600)}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

export function TuiApprovalCard({
  approval,
  height = 10,
  detailOffset = 0,
  onDetailExtent,
}: {
  approval: TuiApproval;
  height?: number;
  detailOffset?: number;
  onDetailExtent?: (maximum: number) => void;
}): React.JSX.Element {
  height = Math.max(0, Math.floor(height));
  if (height < 5)
    return (
      <Box height={height} overflow="hidden" flexDirection="column" flexShrink={0}>
        {height > 1 && (
          <Text color="yellow" wrap="truncate-end">
            Approval: {terminalText(approval.toolName)} · {terminalText(approval.target)}
          </Text>
        )}
        {height > 2 && (
          <TuiViewport
            height={height - 2}
            offset={detailOffset}
            anchor="start"
            onExtent={onDetailExtent}
          >
            <Text>{terminalText(approval.preview.summary)}</Text>
            {approval.preview.fields.map((field, index) => (
              <Text key={`${index}-${field.label}`}>
                {terminalText(field.label)}: {terminalText(field.value)}
              </Text>
            ))}
          </TuiViewport>
        )}
        {height > 0 && (
          <Text color="yellow" wrap="truncate-end">
            Ctrl-Y approve · Ctrl-N deny · Alt-G session
          </Text>
        )}
      </Box>
    );
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      height={height}
      flexShrink={0}
    >
      <Text bold color="yellow" wrap="truncate-end">
        Approval required · {terminalText(approval.toolName)}
      </Text>
      {height >= 7 && <Text wrap="truncate-end">{terminalText(approval.preview.summary)}</Text>}
      {height >= 8 && (
        <Text wrap="truncate-end">
          Target: {terminalText(approval.target)} · Risk: {terminalText(approval.risk)}
        </Text>
      )}
      <TuiViewport
        height={height - 4 - (height >= 7 ? 1 : 0) - (height >= 8 ? 1 : 0)}
        offset={detailOffset}
        anchor="start"
        onExtent={onDetailExtent}
      >
        {approval.preview.fields.map((field, index) => (
          <Text key={`${index}-${field.label}`}>
            {terminalText(field.label)}: {terminalText(field.value)}
          </Text>
        ))}
        <Text dimColor>
          {terminalText(approval.preview.context.source)} /{' '}
          {terminalText(approval.preview.context.client)} · expires{' '}
          {new Date(approval.expiresAt).toISOString()}
        </Text>
      </TuiViewport>
      <Text color="yellow" wrap="truncate-end">
        Ctrl-Y approve · Ctrl-N deny · Alt-G session
      </Text>
    </Box>
  );
}
