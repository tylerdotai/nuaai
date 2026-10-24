import { renderToString } from 'ink';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { TuiConversation } from '../src/ui/tui-conversation.js';

it('renders repeated citation and artifact labels without React key warnings or dropping provenance rows', () => {
  const warnings = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const citation = { title: 'Example Domain', url: 'https://example.com/' };
    const output = renderToString(
      createElement(TuiConversation, {
        title: 'Duplicate provenance',
        messages: [
          {
            id: 'message',
            role: 'assistant',
            content: 'Captured page title.',
            citations: [citation, citation],
            artifacts: [
              { type: 'unsupported', title: 'Same artifact' },
              { type: 'unsupported', title: 'Same artifact' },
            ],
          },
        ],
        stream: '',
        input: '',
        historyOffset: 0,
        tools: [],
        height: 35,
        columns: 120,
      }),
      { columns: 120 },
    );
    expect(output.match(/Citation: Example Domain/g)).toHaveLength(2);
    expect(output.match(/Artifact: Same artifact/g)).toHaveLength(2);
    expect(warnings.mock.calls.flat().join(' ')).not.toContain('same key');
  } finally {
    warnings.mockRestore();
  }
});
