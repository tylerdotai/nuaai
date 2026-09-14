import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { groupSessionsForRail } from '../src/web/navigation.js';
import { NavigationTabs } from '../src/web/views.js';

describe('conversation navigation', () => {
  it('filters sessions and groups results by useful recency labels', () => {
    const now = new Date('2026-09-14T12:00:00Z').getTime();
    const groups = groupSessionsForRail(
      [
        { id: 'today', title: 'Repository review', status: 'active', createdAt: now - 60_000 },
        {
          id: 'week',
          title: 'Deployment checklist',
          status: 'active',
          createdAt: now - 3 * 86_400_000,
        },
        {
          id: 'older',
          title: 'Old architecture notes',
          status: 'active',
          createdAt: now - 20 * 86_400_000,
        },
      ],
      '',
      now,
    );

    expect(
      groups.map((group) => [group.label, group.sessions.map((session) => session.id)]),
    ).toEqual([
      ['Today', ['today']],
      ['Previous 7 days', ['week']],
      ['Older', ['older']],
    ]);
    expect(
      groupSessionsForRail(
        groups.flatMap((group) => group.sessions),
        'deploy',
        now,
      ),
    ).toEqual([
      expect.objectContaining({
        label: 'Previous 7 days',
        sessions: [expect.objectContaining({ id: 'week' })],
      }),
    ]);
  });

  it('keeps mobile navigation to Chat, Memory, and System', () => {
    const markup = renderToStaticMarkup(
      createElement(NavigationTabs, {
        mobile: true,
        view: 'conversation',
        memoryCount: 2,
        automationCount: 1,
        onChange: vi.fn(),
      }),
    );

    expect(markup).toContain('Chat');
    expect(markup).toContain('Memory');
    expect(markup).toContain('System');
    expect(markup).not.toContain('Automate');
    expect(markup.match(/role="tab"/g)).toHaveLength(3);
  });
});
