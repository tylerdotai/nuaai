import { renderToString } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { TuiConversation } from '../src/ui/tui-conversation.js';
import { TuiPicker } from '../src/ui/tui-picker.js';

it('renders a conversation-first page with older history and compact tool activity', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: 'user',
    content: `Message ${index}`,
  }));
  const output = renderToString(
    createElement(TuiConversation, {
      title: 'Review',
      messages,
      stream: '',
      input: 'Draft',
      historyOffset: 4,
      tools: [{ name: 'read_file', status: 'completed' }],
    }),
    { columns: 80 },
  );
  expect(output).toContain('Message 5');
  expect(output).not.toContain('Message 11');
  expect(output).toContain('Draft');
  expect(output).toContain('PgUp/PgDn');
  expect(output).not.toContain('Sessions');
  expect(output).not.toContain('Threads');
  expect(output).toContain('4 rows above');
});

it('keeps tool activity attached to its assistant turn, before its answer and the next user turn', () => {
  const output = renderToString(
    createElement(TuiConversation, {
      title: 'Inline tools',
      height: 40,
      columns: 80,
      stream: '',
      input: '',
      historyOffset: 0,
      tools: [],
      messages: [
        { role: 'user', content: 'Read it' },
        {
          role: 'assistant',
          runId: 'first',
          content: 'Here is the result',
          tools: [
            {
              id: 'call-1',
              name: 'workspace.list',
              status: 'failed',
              detail: 'Permission denied in container storage',
            },
          ],
        },
        { role: 'user', content: 'Next request' },
      ],
    }),
    { columns: 80 },
  );
  expect(output.indexOf('workspace.list')).toBeGreaterThan(output.indexOf('Read it'));
  expect(output.indexOf('workspace.list')).toBeLessThan(output.indexOf('Here is the result'));
  expect(output.indexOf('Permission denied')).toBeLessThan(output.indexOf('Next request'));
});

it('keeps the composer on screen and scrolls within a single long reply', () => {
  const props = {
    title: 'Long conversation',
    messages: [
      {
        role: 'assistant',
        content: Array.from({ length: 100 }, (_, i) => `Reply line ${i}`).join('\n'),
      },
    ],
    stream: '',
    input: 'Composer stays visible',
    historyOffset: 0,
    tools: [],
    height: 18,
    columns: 60,
  };
  const latest = renderToString(createElement(TuiConversation, props), { columns: 60 });
  expect(latest.split('\n').length).toBeLessThanOrEqual(18);
  expect(latest).toContain('Reply line 99');
  expect(latest).not.toContain('Reply line 0\n');
  expect(latest).toContain('Composer stays visible');
  const older = renderToString(createElement(TuiConversation, { ...props, historyOffset: 90 }), {
    columns: 60,
  });
  expect(older).toContain('Reply line 0');
  expect(older).not.toContain('Reply line 99');
  expect(older).toContain('Composer stays visible');
});

it('bounds large pickers and keeps the selected item visible alongside scrollable details', () => {
  const output = renderToString(
    createElement(TuiPicker, {
      busy: false,
      height: 14,
      picker: {
        title: 'Large picker',
        query: '',
        index: 99,
        detailOffset: 12,
        detail: Array.from({ length: 30 }, (_, i) => `Detail ${i}`),
        items: Array.from({ length: 100 }, (_, i) => ({
          id: String(i),
          label: `Item ${i}`,
          detail: 'Long description '.repeat(20),
        })),
      },
    }),
    { columns: 80 },
  );
  expect(output.trim().split('\n').length).toBeLessThanOrEqual(14);
  expect(output).toContain('Item 99');
  expect(output).toContain('Detail 12');
  expect(output).not.toContain('Detail 0\n');
});
