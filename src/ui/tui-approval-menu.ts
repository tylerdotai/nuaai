import type { PickerState } from './tui-picker.js';

export function approvalModeMenu(
  sessionId: string,
  policy: { mode: string; grants: Array<{ tool: string; target: string }> },
): PickerState {
  return {
    title: 'Approval mode',
    query: '',
    index: 0,
    items: [
      {
        id: `policy:${JSON.stringify([sessionId, 'manual', false])}`,
        label: 'Manual',
        detail: 'Prompt for governed actions; harmless reads run without prompts.',
      },
      {
        id: `policy:${JSON.stringify([sessionId, 'smart', false])}`,
        label: 'Smart',
        detail:
          'Routine local work runs automatically. Uncertain actions use a separate model assessment (may incur provider usage). Destructive/external actions ask.',
      },
      {
        id: `policy:${JSON.stringify([sessionId, 'unguarded', false])}`,
        label: 'Unguarded',
        detail:
          'Skip action approval prompts after confirmation, including host-account CLI execution. Does not unlock disabled integrations.',
      },
      {
        id: `policy:${JSON.stringify([sessionId, 'reset', false])}`,
        label: 'Revoke session grants',
        detail: 'Remove saved scopes and return to Manual.',
      },
    ],
    detail: [
      `Current: ${policy.mode}`,
      ...policy.grants.map((grant) => `Session grant: ${grant.tool} · ${grant.target}`),
    ],
  };
}
