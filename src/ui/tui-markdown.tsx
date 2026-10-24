import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

// Model output must not be able to send terminal escape commands.
export function terminalText(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately strip terminal OSC controls.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately strip terminal CSI controls.
      .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/gu, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: remove control bytes, preserve newlines and tabs.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '')
  );
}

function inline(value: string): ReactNode[] {
  const tokens = value.split(
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*[^*]+\*)/gu,
  );
  return tokens.map((token, index) => {
    if (token.startsWith('`') && token.endsWith('`'))
      return (
        <Text key={`${index}-${token}`} color="cyan">
          {token.slice(1, -1)}
        </Text>
      );
    if (
      (token.startsWith('**') && token.endsWith('**')) ||
      (token.startsWith('__') && token.endsWith('__'))
    )
      return (
        <Text key={`${index}-${token}`} bold>
          {token.slice(2, -2)}
        </Text>
      );
    if (token.startsWith('*') && token.endsWith('*'))
      return (
        <Text key={`${index}-${token}`} italic>
          {token.slice(1, -1)}
        </Text>
      );
    const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/u);
    if (link)
      return (
        <Text key={`${index}-${token}`} color="blue">
          {link[1]} ({link[2]})
        </Text>
      );
    return token;
  });
}

/** Terminal-safe common Markdown; unknown syntax remains readable literal text. */
export function TuiMarkdown({ content }: { content: string }): React.JSX.Element {
  let fence: string | null = null;
  const lines = terminalText(content).split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/u);
        if (marker && (!fence || marker[1][0] === fence[0])) {
          if (fence) {
            fence = null;
            return null;
          }
          fence = marker[1];
          return (
            <Text key={`${index}-${line}`} dimColor>
              {marker[2].trim() || 'code'}
            </Text>
          );
        }
        if (fence)
          return (
            <Text key={`${index}-${line}`} color="cyan">
              {line || ' '}
            </Text>
          );
        const heading = line.match(/^#{1,6}\s+(.+)$/u);
        if (heading)
          return (
            <Text key={`${index}-${line}`} bold>
              {inline(heading[1])}
            </Text>
          );
        if (/^\s*([-*_])(?:\s*\1){2,}\s*$/u.test(line))
          return (
            <Text key={`${index}-${line}`} dimColor>
              ────────
            </Text>
          );
        if (line.startsWith('> '))
          return (
            <Text key={`${index}-${line}`} dimColor>
              │ {inline(line.slice(2))}
            </Text>
          );
        const bullet = line.replace(/^\s*[-*+]\s+/u, '• ');
        return <Text key={`${index}-${line}`}>{inline(bullet || ' ')}</Text>;
      })}
    </Box>
  );
}
