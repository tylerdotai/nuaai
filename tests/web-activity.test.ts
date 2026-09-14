import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { RunStatusSummary, formatActivitySummary } from '../src/web/components/RunStatusSummary.js';
import type { ActivityGroup, MessageView } from '../src/web/contracts.js';

function activity(status: ActivityGroup['status'] = 'completed'): ActivityGroup {
  return {
    runId: 'run-48',
    status,
    startedAt: 1_000,
    completedAt: status === 'streaming' ? undefined : 246_000,
    items: Array.from({ length: 48 }, (_, index) => ({
      id: `tool-${index}`,
      name: index < 30 ? 'workspace.read' : 'workspace.search',
      status: status === 'completed' ? 'completed' : status === 'streaming' ? 'running' : 'failed',
      target: index < 30 ? `src/file-${index}.ts` : `query-${index}`,
      startedAt: 1_000 + index * 100,
      completedAt: status === 'streaming' ? undefined : 1_050 + index * 100,
      durationMs: status === 'streaming' ? undefined : 50,
    })),
  };
}

function message(
  status: MessageView['status'],
  group: ActivityGroup,
  error?: MessageView['error'],
): MessageView {
  return {
    id: 'run:run-48:assistant',
    runId: 'run-48',
    role: 'assistant',
    markdown: status === 'streaming' ? 'Working' : 'Finished',
    createdAt: 1_000,
    provider: { name: 'codex', model: 'gpt-test' },
    status,
    activities: [group],
    ...(error ? { error } : {}),
    citations: [],
    attachments: [],
    artifacts: [],
  };
}

describe('response-local run activity', () => {
  it('hides a completed status surface when the run used no tools', () => {
    const message: MessageView = {
      id: 'run:text:assistant',
      runId: 'text',
      role: 'assistant',
      markdown: 'Plain answer',
      status: 'completed',
      createdAt: 0,
      activities: [
        { runId: 'text', status: 'completed', startedAt: 0, completedAt: 10, items: [] },
      ],
      citations: [],
      attachments: [],
      artifacts: [],
    };

    expect(renderToStaticMarkup(createElement(RunStatusSummary, { message }))).toBe('');
  });

  it('summarizes 48 calls and expands all distinct terminal rows', () => {
    const group = activity();
    expect(formatActivitySummary(group)).toBe('48 actions · 30 files read · 18 searches · 4m 05s');

    const markup = renderToStaticMarkup(
      createElement(RunStatusSummary, {
        message: message('completed', group),
        defaultExpanded: true,
      }),
    );

    expect(markup.match(/data-activity-id=/g)).toHaveLength(48);
    expect(markup).toContain('48 actions · 30 files read · 18 searches · 4m 05s');
    expect(markup).not.toContain('>Running<');
    expect(markup).toContain('aria-expanded="true"');
  });

  it('keeps the failure cause visible and exposes Retry and Inspect controls', () => {
    const group = activity('failed');
    const markup = renderToStaticMarkup(
      createElement(RunStatusSummary, {
        message: message('failed', group, {
          message: 'Provider disconnected after the final tool result.',
          code: 'provider_disconnected',
          retryable: true,
        }),
        onRetry: vi.fn(),
      }),
    );

    expect(markup).toContain('Provider disconnected after the final tool result.');
    expect(markup).toContain('>Retry<');
    expect(markup).toContain('>Inspect<');
    expect(markup).toContain('data-status="failed"');
  });

  it('shows Stop only while the selected response is actively streaming', () => {
    const markup = renderToStaticMarkup(
      createElement(RunStatusSummary, {
        message: message('streaming', activity('streaming')),
        active: true,
        onStop: vi.fn(),
      }),
    );

    expect(markup).toContain('>Stop<');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain('>Retry<');
  });
});
