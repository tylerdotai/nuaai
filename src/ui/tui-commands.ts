import { graphemeCells, graphemeCursor, graphemes, terminalCells } from './tui-unicode.js';

export const tuiCommands = [
  {
    command: 'permissions',
    description: 'Choose Manual, Smart or Unguarded approvals; review or revoke session grants',
    usage: '/permissions [manual|smart|unguarded|reset]',
  },
  {
    command: 'skill',
    description: 'Read full instructions for an enabled skill',
    usage: '/skill <name>',
  },
  {
    command: 'skill-create',
    description: 'Save an instruction-only skill to the runtime library',
    usage: '/skill-create <name>|<instructions>',
  },
  {
    command: 'identity',
    description: 'Inspect frozen instruction sources without private content',
    usage: '/identity',
  },
  {
    command: 'identity-refresh',
    description: 'Confirm reloading instruction sources for future runs',
    usage: '/identity-refresh',
  },
  {
    command: 'outputs',
    description: 'Copy responses/code or open/save artifacts',
    usage: '/outputs',
  },
  {
    command: 'export',
    description: 'Export the complete conversation to a new Markdown file',
    usage: '/export [destination path]',
  },
  {
    command: 'attach',
    description: 'Attach a local file; Tab completes paths, including spaces',
    usage: '/attach [path]',
  },
  {
    command: 'attachments',
    description: 'Inspect or remove pending attachments',
    usage: '/attachments',
  },
  {
    command: 'search',
    description: 'Search all turns in this conversation, including older history',
    usage: '/search [text]',
  },
  { command: 'search-next', description: 'Jump to the next matching turn', usage: '/search-next' },
  {
    command: 'search-prev',
    description: 'Jump to the previous matching turn',
    usage: '/search-prev',
  },
  {
    command: 'model',
    description: 'Choose a model across available providers',
    usage: '/model [model name]',
  },
  {
    command: 'provider',
    description: 'Choose a provider, then its model',
    usage: '/provider [name]',
  },
  {
    command: 'settings',
    description: 'Provider, model, appearance, skills and plugins',
    usage: '/settings',
  },
  { command: 'sessions', description: 'Search and switch conversations', usage: '/sessions' },
  { command: 'threads', description: 'Search and switch threads', usage: '/threads' },
  { command: 'new', description: 'Create a conversation', usage: '/new [title]' },
  {
    command: 'thread',
    description: 'Create a thread in this conversation',
    usage: '/thread [title]',
  },
  {
    command: 'delete',
    description: 'Delete this conversation after confirmation',
    usage: '/delete',
  },
  {
    command: 'delete-thread',
    description: 'Delete this thread after confirmation',
    usage: '/delete-thread',
  },
  {
    command: 'schedule-edit',
    description: 'Edit an existing automation',
    usage: '/schedule-edit id|name|type|expression|agent input',
  },
  { command: 'rename', description: 'Rename this conversation', usage: '/rename <title>' },
  { command: 'rename-thread', description: 'Rename this thread', usage: '/rename-thread <title>' },
  {
    command: 'approvals',
    description: 'Focus inline action cards; Ctrl-Y approve once, Ctrl-N deny',
    usage: '/approvals',
  },
  { command: 'cancel', description: 'Cancel the current run', usage: '/cancel' },
  {
    command: 'resume',
    description: 'Resume an interrupted run after confirmation',
    usage: '/resume',
  },
  { command: 'status', description: 'Connection, active provider and model', usage: '/status' },
  { command: 'tasks', description: 'Show background tasks', usage: '/tasks' },
  { command: 'schedules', description: 'Show automations', usage: '/schedules' },
  {
    command: 'schedule',
    description: 'Create an automation',
    usage: '/schedule name|type|expression|agent input',
  },
  { command: 'memory', description: 'Show durable memory', usage: '/memory' },
  { command: 'remember', description: 'Save a durable memory', usage: '/remember <text>' },
  { command: 'skills', description: 'Enable or disable a skill', usage: '/skills' },
  { command: 'plugins', description: 'Enable or disable a trusted plugin', usage: '/plugins' },
  { command: 'refresh', description: 'Reload daemon state', usage: '/refresh' },
  { command: 'chat', description: 'Return to the conversation', usage: '/chat' },
  { command: 'help', description: 'Commands and keyboard shortcuts', usage: '/help' },
  { command: 'quit', description: 'Exit the TUI; leave daemon running', usage: '/quit' },
];

export function parseCommand(input: string): { command: string; argument: string } | null {
  const match = input.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/u);
  return match ? { command: match[1].toLowerCase(), argument: match[2]?.trim() ?? '' } : null;
}

export function commandMatches(input: string) {
  const query = input.replace(/^\//u, '').toLowerCase();
  return tuiCommands
    .filter((item) => item.command.startsWith(query))
    .sort((left, right) => Number(right.command === query) - Number(left.command === query));
}

export interface Draft {
  text: string;
  cursor: number;
}
export interface EditorKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  return?: boolean;
}

export function editDraft(draft: Draft, input: string, key: EditorKey): Draft {
  const { text } = draft;
  const cursor = graphemeCursor(text, draft.cursor);
  const boundaries = [...graphemes(text).map((item) => item.index), text.length];
  const position = boundaries.indexOf(cursor);
  const previous = boundaries[Math.max(0, position - 1)];
  const next = boundaries[Math.min(boundaries.length - 1, position + 1)];
  if (key.upArrow || key.downArrow) {
    const lineStart = cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1;
    const column = terminalCells(text.slice(lineStart, cursor));
    const previousEnd = lineStart - 1;
    const nextEnd = text.indexOf('\n', cursor);
    if ((key.upArrow && previousEnd < 0) || (key.downArrow && nextEnd < 0)) return draft;
    const targetStart = key.upArrow ? text.lastIndexOf('\n', previousEnd - 1) + 1 : nextEnd + 1;
    const targetEnd = text.indexOf('\n', targetStart);
    const line = text.slice(targetStart, targetEnd < 0 ? text.length : targetEnd);
    let target = 0;
    let cells = 0;
    for (const item of graphemes(line)) {
      cells += graphemeCells(item.segment);
      if (cells > column) break;
      target = item.index + item.segment.length;
    }
    return { text, cursor: targetStart + target };
  }
  if (key.home || (key.ctrl && input === 'a')) return { text, cursor: 0 };
  if (key.end || (key.ctrl && input === 'e')) return { text, cursor: text.length };
  if (key.leftArrow) return { text, cursor: previous };
  if (key.rightArrow) return { text, cursor: next };
  if (key.ctrl && input === 'u') return { text: text.slice(cursor), cursor: 0 };
  if (key.ctrl && input === 'k') return { text: text.slice(0, cursor), cursor };
  if (key.backspace) {
    const changed = text.slice(0, previous) + text.slice(cursor);
    return { text: changed, cursor: graphemeCursor(changed, previous) };
  }
  if (key.delete) {
    const changed = text.slice(0, cursor) + text.slice(next);
    return { text: changed, cursor: graphemeCursor(changed, cursor) };
  }
  if (key.ctrl || key.meta || !input) return draft;
  const inserted = input.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const changed = text.slice(0, cursor) + inserted + text.slice(cursor);
  const target = cursor + inserted.length;
  return {
    text: changed,
    cursor: graphemes(changed).find((item) => item.index >= target)?.index ?? changed.length,
  };
}
