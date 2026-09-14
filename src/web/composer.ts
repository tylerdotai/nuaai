import type { PermissionProfile } from './contracts.js';

export type ComposerAction = 'disabled' | 'send' | 'queue' | 'stop';
export type ComposerCommand = 'new-session' | 'refresh' | 'memory' | 'automations' | 'system';

export function composerAction({
  input,
  activeRunId,
}: {
  input: string;
  activeRunId: string | null;
}): ComposerAction {
  if (input.trim()) return activeRunId ? 'queue' : 'send';
  return activeRunId ? 'stop' : 'disabled';
}

export function draftStorageKey(threadId: string | null): string | null {
  return threadId ? `nuaai:draft:${encodeURIComponent(threadId)}` : null;
}

const composerCommands: Record<string, ComposerCommand> = {
  '/new': 'new-session',
  '/refresh': 'refresh',
  '/memory': 'memory',
  '/automate': 'automations',
  '/system': 'system',
};

export function resolveComposerCommand(input: string): ComposerCommand | null {
  return composerCommands[input.trim().toLowerCase()] ?? null;
}

export function capabilitySummary(profile: PermissionProfile): {
  label: string;
  capabilities: string[];
} {
  const shared = ['Read workspace', 'Search memory', 'Inspect run history'];
  if (profile === 'read-only') return { label: 'Read only', capabilities: shared };
  return {
    label: 'Operator',
    capabilities: [
      'Read workspace',
      'Write workspace',
      'Run approved commands',
      'Search memory',
      'Inspect run history',
    ],
  };
}

export function textareaHeight(scrollHeight: number, expanded = false): number {
  return Math.min(expanded ? 520 : 240, Math.max(44, scrollHeight));
}
