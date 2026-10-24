import { describe, expect, it } from 'vitest';
import { commandMatches, editDraft, parseCommand } from '../src/ui/tui-commands.js';

describe('terminal command and editing contracts', () => {
  it('recognizes commands without sending unknown commands to the model', () => {
    expect(parseCommand('/model gpt-6-astra')).toEqual({
      command: 'model',
      argument: 'gpt-6-astra',
    });
    expect(parseCommand('/new Research notes')).toEqual({
      command: 'new',
      argument: 'Research notes',
    });
    expect(parseCommand('normal message')).toBeNull();
    expect(commandMatches('/mod').map((item) => item.command)).toContain('model');
    expect(commandMatches('/not-a-command')).toEqual([]);
  });
  it('moves vertically inside multiline drafts without replacing them with sent history', () => {
    expect(editDraft({ text: 'one\nsecond\nlast', cursor: 8 }, '', { upArrow: true })).toEqual({
      text: 'one\nsecond\nlast',
      cursor: 3,
    });
    expect(editDraft({ text: 'one\nsecond\nlast', cursor: 2 }, '', { downArrow: true })).toEqual({
      text: 'one\nsecond\nlast',
      cursor: 6,
    });
  });
  it('edits at the cursor, preserves pasted lines, and deletes whole Unicode characters', () => {
    expect(editDraft({ text: 'ac', cursor: 1 }, 'b', {})).toEqual({ text: 'abc', cursor: 2 });
    expect(editDraft({ text: 'a😀b', cursor: 3 }, '', { backspace: true })).toEqual({
      text: 'ab',
      cursor: 1,
    });
    expect(editDraft({ text: 'abc', cursor: 1 }, '', { delete: true })).toEqual({
      text: 'ac',
      cursor: 1,
    });
    expect(editDraft({ text: '', cursor: 0 }, 'one\ntwo', {})).toEqual({
      text: 'one\ntwo',
      cursor: 7,
    });
    expect(editDraft({ text: 'abc', cursor: 3 }, 'a', { ctrl: true })).toEqual({
      text: 'abc',
      cursor: 0,
    });
  });
});
