import type { LearningStatus } from '../memory/learning.js';
import type { PickerState } from './tui-picker.js';

export function learningModeMenu(status: LearningStatus | null): PickerState {
  const choices = [
    {
      mode: 'automatic',
      label: 'Automatic',
      detail:
        'Selectively review meaningful completed work and save evidence-backed workspace knowledge.',
    },
    {
      mode: 'manual',
      label: 'Manual',
      detail: 'No automatic review. The agent saves only when explicitly asked.',
    },
    {
      mode: 'off',
      label: 'Off',
      detail:
        'Disable automatic review and agent saves. Retain existing notes for review and owner management.',
    },
  ] as const;
  return {
    title: 'Agent learning',
    query: '',
    index: 0,
    detail: [
      `Current: ${status?.available ? status.mode : 'unavailable'}`,
      'Applies to agent memory across this daemon. Does not change tool permissions.',
    ],
    items: status?.available
      ? choices.map((choice) => ({
          id: `learning:${choice.mode}`,
          label: `${choice.label}${status.mode === choice.mode ? ' · current' : ''}`,
          detail: choice.detail,
        }))
      : [],
  };
}
