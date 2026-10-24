import { renderToString } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { TuiRuntimeStatus } from '../src/ui/tui-status.js';

it('shows daemon state, model availability and context without dumping raw configuration', () => {
  const output = renderToString(
    createElement(TuiRuntimeStatus, {
      endpoint: 'http://127.0.0.1:1234',
      status: {
        activeRuns: 1,
        queuedRuns: 2,
        sessions: 3,
        active: { name: 'codex', model: 'test-model' },
        providers: [{ name: 'codex', available: true, detail: 'OAuth ready' }],
        context: { maxTokens: 262144, responseReserveTokens: 8192 },
        webPermissionProfile: 'operator',
      },
    }),
    { columns: 80 },
  );
  expect(output).toContain('1 active');
  expect(output).toContain('2 queued');
  expect(output).toContain('3 conversations');
  expect(output).toContain('codex / test-model');
  expect(output).toContain('OAuth ready');
  expect(output).toContain('262144');
  expect(output).toContain('/settings');
});
