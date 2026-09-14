import type { Session } from './contracts.js';

export interface SessionRailGroup {
  label: 'Today' | 'Previous 7 days' | 'Older';
  sessions: Session[];
}

export function groupSessionsForRail(
  sessions: Session[],
  query: string,
  now = Date.now(),
): SessionRailGroup[] {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery))
    : sessions;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const weekStart = todayStart - 7 * 86_400_000;
  const groups: SessionRailGroup[] = [
    { label: 'Today', sessions: [] },
    { label: 'Previous 7 days', sessions: [] },
    { label: 'Older', sessions: [] },
  ];
  for (const session of filtered) {
    const createdAt = session.createdAt ?? 0;
    if (createdAt >= todayStart) groups[0]?.sessions.push(session);
    else if (createdAt >= weekStart) groups[1]?.sessions.push(session);
    else groups[2]?.sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length > 0);
}
