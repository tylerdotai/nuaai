import { Box, Text } from 'ink';
import { terminalText } from './tui-markdown.js';
import type { TuiProviderHealth } from './tui-state.js';

export interface TuiRuntimeSummary {
  activeRuns: number;
  queuedRuns: number;
  sessions: number;
  active: { name: string; model: string };
  providers: TuiProviderHealth[];
  context?: { maxTokens: number; responseReserveTokens: number };
  webPermissionProfile?: string;
}
export function TuiRuntimeStatus({
  endpoint,
  status,
}: { endpoint: string; status: TuiRuntimeSummary }): React.JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Runtime status</Text>
      <Text dimColor>{endpoint}</Text>
      <Text>
        {status.activeRuns} active · {status.queuedRuns} queued · {status.sessions} conversations
      </Text>
      <Box flexDirection="column">
        <Text bold>Model</Text>
        <Text color="blue">
          {status.active.name} / {status.active.model}
        </Text>
        {status.providers.map((provider) => (
          <Text key={provider.name} color={provider.available ? 'green' : 'yellow'}>
            {provider.available ? '●' : '○'} {provider.name} · {terminalText(provider.detail)}
          </Text>
        ))}
      </Box>
      {status.context && (
        <Text>
          Context budget: {status.context.maxTokens} tokens · response reserve{' '}
          {status.context.responseReserveTokens}
        </Text>
      )}
      {status.webPermissionProfile && (
        <Text>Operator client permission profile: {status.webPermissionProfile}</Text>
      )}
      <Text dimColor>/settings configure · /refresh reload · /chat return · PgUp/PgDn scroll</Text>
    </Box>
  );
}
