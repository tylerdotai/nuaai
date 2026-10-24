import { renderToString } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { TuiConversation } from '../src/ui/tui-conversation.js';

it('keeps the accepted user turn before its live tools/reply and a queued user turn after it', () => {
  for (const stream of ['ASSISTANT_STREAM', '']) {
    const output = renderToString(
      createElement(TuiConversation, {
        title: 'Chronological chat',
        messages: [
          { id: 'user-current', role: 'user', runId: 'current', content: 'ACCEPTED_USER_QUESTION' },
          {
            id: 'assistant-current',
            role: 'assistant',
            runId: 'current',
            content: 'ASSISTANT_PARTIAL',
          },
          { id: 'user-queued', role: 'user', runId: 'queued', content: 'QUEUED_USER_QUESTION' },
        ],
        stream,
        input: 'UNSENT_DRAFT',
        activeRunId: 'current',
        historyOffset: 0,
        tools: [
          { id: 'tool-current', name: 'workspace.read', target: 'report.html', status: 'running' },
        ],
        height: 38,
        columns: 120,
      }),
      { columns: 120 },
    );
    expect(output.match(/ACCEPTED_USER_QUESTION/g)).toHaveLength(1);
    expect(output.indexOf('ACCEPTED_USER_QUESTION')).toBeLessThan(output.indexOf('workspace.read'));
    expect(output.indexOf('workspace.read')).toBeLessThan(
      output.indexOf(stream || 'ASSISTANT_PARTIAL'),
    );
    expect(output.indexOf(stream || 'ASSISTANT_PARTIAL')).toBeLessThan(
      output.indexOf('QUEUED_USER_QUESTION'),
    );
    expect(output).toContain('UNSENT_DRAFT');
    expect(output.indexOf('You')).toBeLessThan(output.indexOf('NUAAI'));
  }
});
