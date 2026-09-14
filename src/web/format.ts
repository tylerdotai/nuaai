import type { ActiveProvider, ConnectionState, ViewId } from './contracts.js';

export const views: Array<{ id: ViewId; label: string; shortLabel: string }> = [
  { id: 'conversation', label: 'Conversation', shortLabel: 'Chat' },
  { id: 'memory', label: 'Memory', shortLabel: 'Memory' },
  { id: 'automations', label: 'Automations', shortLabel: 'Automate' },
  { id: 'system', label: 'System', shortLabel: 'System' },
];

export function newConversationTitle(): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(new Date())
    .replace(',', ' ·');
}

export function relativeTime(value?: number | null): string {
  if (!value) return 'Not scheduled';
  const difference = value - Date.now();
  const minutes = Math.round(Math.abs(difference) / 60_000);
  if (minutes < 1) return difference >= 0 ? 'Now' : 'Just now';
  if (minutes < 60) return difference >= 0 ? `In ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return difference >= 0 ? `In ${hours}h` : `${hours}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(value);
}

export function displayProviderName(name: string): string {
  return name === 'ollama' ? 'Local' : name;
}

export function displayModel(active: ActiveProvider | null): string {
  if (!active) return 'No provider';
  return `${displayProviderName(active.name).toLowerCase()} · ${active.model || 'CLI default'}`;
}

export function providerUnavailableNotice(
  error: string,
  requestedProvider: string,
  activeProvider: ActiveProvider | null,
): string | undefined {
  if (
    activeProvider?.name === requestedProvider ||
    !error.startsWith(`Provider ${requestedProvider} is unavailable:`)
  )
    return undefined;
  const failedProvider = displayProviderName(requestedProvider);
  const currentProvider = activeProvider
    ? displayProviderName(activeProvider.name).toLowerCase()
    : 'current provider';
  return `${failedProvider.charAt(0).toUpperCase()}${failedProvider.slice(1)} unavailable · ${currentProvider} remains active`;
}

export function runLabel(status?: string): string {
  if (status === 'queued') return 'Queued';
  if (status === 'running') return 'Reasoning';
  if (status === 'action') return 'Using an action';
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  return 'Idle';
}

export function connectionLabel(state: ConnectionState): string {
  if (state === 'connected') return 'Connected';
  if (state === 'reconnecting') return 'Reconnecting';
  if (state === 'offline') return 'Offline';
  return 'Connecting';
}
