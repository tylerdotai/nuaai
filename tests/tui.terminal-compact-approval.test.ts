import { renderToString } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { TuiApprovalCard } from '../src/ui/tui-activity.js';
import type { TuiApproval } from '../src/ui/tui-state.js';

it('keeps meaningful approval fields scrollable even in a three-row card', () => {
  const approval: TuiApproval = {
    id: 'small',
    runId: 'run',
    threadId: 'thread',
    toolName: 'workspace.write',
    status: 'pending',
    payloadHash: 'hash',
    target: 'file',
    risk: 'write',
    createdAt: 0,
    expiresAt: 1900000000000,
    providerOwned: false,
    preview: {
      version: 1,
      kind: 'write',
      summary: 'Write file',
      fields: [{ label: 'Text', value: 'REVIEW_ME' }],
      context: { source: 'tui', client: 'test' },
    },
  };
  const output = renderToString(
    createElement(TuiApprovalCard, { approval, height: 3, detailOffset: 1 }),
    { columns: 38 },
  );
  expect(output).toContain('REVIEW_ME');
  expect(output).toContain('Ctrl-Y');
  expect(output).toContain('Ctrl-N');
  expect(output.split('\n').length).toBeLessThanOrEqual(3);
});
