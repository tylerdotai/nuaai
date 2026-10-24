import type { EditorKey } from './tui-commands.js';

// One source for dispatch, command hints, and searchable shortcut help.
// Avoid Ctrl-H/I/J (Backspace/Tab/Enter) and Ctrl-S/Q (terminal flow control).
// Ctrl-M is accepted only when Ink reports a distinct modified key, never Return.
export const tuiShortcuts = [
  { command: 'identity', keys: ['Alt-Y'], description: 'Inspect session instruction sources' },
  {
    command: 'outputs',
    keys: ['Alt-O'],
    description: 'Copy responses/code or open/save artifacts',
  },
  { command: 'export', keys: ['Alt-X'], description: 'Export the complete conversation' },
  { command: 'attach', keys: ['Alt-W'], description: 'Browse and attach files' },
  { command: 'attachments', keys: ['Alt-E'], description: 'Inspect or remove pending attachments' },
  { command: 'search', keys: ['Alt-Z'], description: 'Search this conversation' },
  { command: 'search-next', keys: ['Alt-J'], description: 'Next matching turn' },
  { command: 'search-prev', keys: ['Alt-V'], description: 'Previous matching turn' },
  {
    command: 'new',
    keys: ['Ctrl-N', 'Alt-N'],
    description: 'New conversation; Ctrl-N denies a visible approval instead',
  },
  { command: 'thread', keys: ['Ctrl-T'], description: 'New thread in this conversation' },
  { command: 'sessions', keys: ['Ctrl-F'], description: 'Find and switch conversations' },
  { command: 'threads', keys: ['Alt-T'], description: 'Find and switch threads' },
  {
    command: 'model',
    keys: ['Ctrl-P', 'Alt-M', 'Ctrl-M'],
    description:
      'Choose a model; Ctrl-M needs distinct modified-key reporting, otherwise use Ctrl-P / Alt-M',
  },
  { command: 'provider', keys: ['Ctrl-O'], description: 'Choose a provider' },
  {
    command: 'help',
    keys: ['Ctrl-G', 'Alt-P', 'Alt-H'],
    description: 'Search commands and keyboard shortcuts',
  },
  { command: 'settings', keys: ['Alt-S'], description: 'Settings and appearance' },
  { command: 'status', keys: ['Alt-U'], description: 'Live runtime status and health' },
  { command: 'approvals', keys: ['Alt-A'], description: 'Focus inline approval cards' },
  { command: 'tasks', keys: ['Alt-B'], description: 'Background tasks' },
  { command: 'schedules', keys: ['Alt-C'], description: 'Automations' },
  { command: 'memory', keys: ['Alt-F'], description: 'Find durable memories' },
  { command: 'skills', keys: ['Alt-I'], description: 'Manage skills' },
  { command: 'plugins', keys: ['Alt-L'], description: 'Manage trusted plugins' },
  { command: 'refresh', keys: ['Ctrl-R'], description: 'Refresh daemon state' },
  { command: 'cancel', keys: ['Ctrl-X'], description: 'Stop the active run, not the daemon' },
  { command: 'resume', keys: ['Alt-R'], description: 'Review an interrupted run before resuming' },
  { command: 'toggle-details', keys: ['Alt-D'], description: 'Toggle expanded tool activity' },
  { command: 'toggle-compact', keys: ['Alt-K'], description: 'Toggle compact transcript spacing' },
];

export function resolveTuiShortcut(input: string, key: EditorKey) {
  if (Boolean(key.ctrl) === Boolean(key.meta) || key.return) return undefined;
  const chord = `${key.ctrl ? 'Ctrl' : 'Alt'}-${input.toUpperCase()}`;
  return tuiShortcuts.find((entry) => entry.keys.includes(chord));
}

export function shortcutHint(command: string): string {
  return tuiShortcuts.find((entry) => entry.command === command)?.keys.join(' / ') ?? '';
}

export const tuiKeyHelp = [
  ['Alt-G', 'Allow the visible reviewed tool/target scope for this session; never through a menu'],
  ['Ctrl-Y / Ctrl-N', 'Approve once / deny the visible exact action; never approve with Enter'],
  ['Ctrl-C', 'Exit the client; leave the daemon running'],
  ['Enter / Alt-Enter', 'Send / insert a newline; Ctrl-M is Enter in conventional terminals'],
  ['Esc', 'Dismiss a picker without losing the draft; from chat, clear the draft'],
  ['Tab', 'Complete a slash command; with an empty draft, cycle approval cards'],
  ['PgUp / PgDn', 'Scroll history; at the top, PgUp loads older messages; scroll picker details'],
  ['Ctrl-Up / Ctrl-Down', 'Previous / next conversation'],
  ['Ctrl-Left / Ctrl-Right', 'Previous / next thread'],
  ['Alt-Up / Alt-Down', 'Recall sent inputs; with an approval, scroll its preview'],
  ['Ctrl-A / Ctrl-E', 'Move to the start / end of the draft'],
  ['Ctrl-U / Ctrl-K', 'Erase before / after the cursor'],
  ['Up / Down', 'Scroll the chat feed; in multiline drafts, move between lines'],
  ['Ctrl-End', 'Jump to live conversation without changing the draft'],
  ['Ctrl-B', 'Previous automation form field; Escape cancels the form'],
];
