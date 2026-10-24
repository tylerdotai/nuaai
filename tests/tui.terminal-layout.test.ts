import { renderToString } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { TuiApprovalCard } from '../src/ui/tui-activity.js';
import { TuiConversation } from '../src/ui/tui-conversation.js';
import type { TuiApproval } from '../src/ui/tui-state.js';

const approval: TuiApproval = {
  id: 'layout',
  runId: 'run',
  threadId: 'thread',
  toolName: 'workspace.write',
  status: 'pending',
  payloadHash: 'hash',
  target: 'file.txt',
  risk: 'write',
  createdAt: 1800000000000,
  providerOwned: false,
  expiresAt: 1900000000000,
  preview: {
    version: 1,
    kind: 'write',
    summary: 'Write text '.repeat(30),
    fields: [{ label: 'Content', value: 'fixture\n'.repeat(50) }],
    context: { source: 'direct', client: 'test' },
  },
};
it('fits long drafts and pending decision controls inside every supplied conversation budget', () => {
  for (const columns of [32, 38, 80])
    for (const height of [1, 3, 6, 10, 14, 24]) {
      const output = renderToString(
        createElement(TuiConversation, {
          title: 'Long title '.repeat(30),
          messages: [],
          stream: '',
          input: 'one\ntwo\nthree\nfour\nfive',
          cursor: 23,
          historyOffset: 0,
          tools: [],
          approvals: [approval],
          height,
          columns,
        }),
        { columns },
      );
      expect(output.split('\n').length, `${columns}x${height}`).toBeLessThanOrEqual(height);
      if (height >= 10) {
        expect(output).toContain('Ctrl-Y');
        expect(output).toContain('Ctrl-N');
        expect(output).toContain('five');
      } else expect(output).toContain('Resize');
    }
});
it('counts approval borders and controls within its height, including compact cards', () => {
  for (const height of [3, 4, 6, 10]) {
    const output = renderToString(createElement(TuiApprovalCard, { approval, height }), {
      columns: 38,
    });
    expect(output.split('\n').length).toBeLessThanOrEqual(height);
    expect(output).toContain('Ctrl-Y');
    expect(output).toContain('Ctrl-N');
  }
});
