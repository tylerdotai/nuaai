import { useEffect, useState } from 'react';

import type { ActivityGroup, ActivityItem, MessageView } from '../contracts.js';

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${String(remainder).padStart(2, '0')}s` : `${remainder}s`;
}

export function formatActivitySummary(group: ActivityGroup): string {
  const runningTool = group.items.find((item) => item.status === 'running');
  if (runningTool) {
    const base = runningTool.name.replace('workspace.', '');
    return `Using ${base}`;
  }
  const reads = group.items.filter((item) => item.name === 'workspace.read').length;
  const searches = group.items.filter((item) => item.name.includes('search')).length;
  const commands = group.items.filter((item) => item.name === 'workspace.command').length;
  const writes = group.items.filter((item) => item.name === 'workspace.write').length;
  const parts = [plural(group.items.length, 'action')];
  if (reads) parts.push(plural(reads, 'file read', 'files read'));
  if (searches) parts.push(plural(searches, 'search', 'searches'));
  if (commands) parts.push(plural(commands, 'command'));
  if (writes) parts.push(plural(writes, 'file written', 'files written'));
  if (group.completedAt !== undefined)
    parts.push(formatDuration(group.completedAt - group.startedAt));
  return parts.join(' · ');
}

function statusLabel(status: ActivityItem['status']): string {
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  return 'Running';
}

export function ToolTimeline({ group }: { group: ActivityGroup }): React.JSX.Element {
  const [expandedArgs, setExpandedArgs] = useState<Set<string>>(new Set());
  const toggleArgs = (id: string): void => {
    setExpandedArgs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <ol className="tool-timeline" aria-label="Run actions">
      {group.items.map((item) => (
        <li key={item.id} data-activity-id={item.id} data-status={item.status}>
          <span className={`activity-state activity-state-${item.status}`} aria-hidden="true" />
          <div className="tool-timeline-content">
            <div className="tool-timeline-heading">
              <strong>{item.name}</strong>
              <span>{statusLabel(item.status)}</span>
            </div>
            {item.target && <code>{item.target}</code>}
            {item.arguments && Object.keys(item.arguments).length > 0 && (
              <button
                type="button"
                className="tool-args-toggle"
                aria-expanded={expandedArgs.has(item.id)}
                onClick={() => toggleArgs(item.id)}
              >
                {expandedArgs.has(item.id) ? 'Hide args' : 'Show args'}
              </button>
            )}
            {item.arguments && expandedArgs.has(item.id) && (
              <pre className="tool-arguments">{JSON.stringify(item.arguments, null, 2)}</pre>
            )}
            {item.detail && <p>{item.detail}</p>}
          </div>
          {item.durationMs !== undefined && (
            <time aria-label={`Duration ${formatDuration(item.durationMs)}`}>
              {formatDuration(item.durationMs)}
            </time>
          )}
        </li>
      ))}
    </ol>
  );
}

export function RunStatusSummary({
  message,
  active = false,
  onStop,
  onRetry,
}: {
  message: MessageView;
  active?: boolean;
  onStop?: () => void;
  onRetry?: () => void;
}): React.JSX.Element | null {
  const group = message.activities[0];
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (message.status !== 'streaming' || !group?.startedAt) {
      setElapsedMs(0);
      return;
    }
    setElapsedMs(Date.now() - group.startedAt);
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - group.startedAt);
    }, 1000);
    return () => clearInterval(interval);
  }, [message.status, group?.startedAt]);
  if (message.status === 'completed' && (!group || group.items.length === 0)) return null;
  const activitySummary = group ? formatActivitySummary(group) : 'Preparing response';
  const elapsedDisplay = elapsedMs > 0 ? ` · ${formatDuration(elapsedMs)}` : '';
  const summary =
    message.status === 'streaming'
      ? `Working${elapsedDisplay} · ${activitySummary}`
      : message.status === 'failed'
        ? `Failed · ${activitySummary}`
        : message.status === 'cancelled'
          ? `Cancelled · ${activitySummary}`
          : activitySummary;

  return (
    <section className="run-status-summary" data-status={message.status}>
      <div className="run-status-row">
        <div className="run-status-copy" aria-live="polite">
          <span className={`run-status-dot run-status-dot-${message.status}`} aria-hidden="true" />
          <span>{summary}</span>
        </div>
        <div className="run-status-actions">
          {message.status === 'failed' && message.error?.retryable && onRetry && (
            <button type="button" aria-label="Retry failed run" onClick={onRetry}>
              Retry
            </button>
          )}
          {active && message.status === 'streaming' && onStop && (
            <button type="button" className="danger-text" onClick={onStop}>
              Stop
            </button>
          )}
        </div>
      </div>
      {message.error && <p className="run-status-error">{message.error.message}</p>}
      {group && <ToolTimeline group={group} />}
    </section>
  );
}
