import { describe, expect, it } from 'vitest';
import { resolveTuiShortcut, shortcutHint, tuiShortcuts } from '../src/ui/tui-shortcuts.js';

describe('terminal shortcut contracts', () => {
  it('maps frequent and mnemonic actions without stealing editing or Enter', () => {
    expect(resolveTuiShortcut('n', { ctrl: true })?.command).toBe('new');
    expect(resolveTuiShortcut('p', { ctrl: true })?.command).toBe('model');
    expect(resolveTuiShortcut('m', { meta: true })?.command).toBe('model');
    expect(resolveTuiShortcut('', { return: true })).toBeUndefined();
    expect(resolveTuiShortcut('m', { ctrl: true })?.command).toBe('model');
    expect(resolveTuiShortcut('m', { ctrl: true, return: true })).toBeUndefined();
    for (const character of ['a', 'e', 'u', 'k', 'h', 'i', 'j'])
      expect(resolveTuiShortcut(character, { ctrl: true })).toBeUndefined();
    expect(resolveTuiShortcut('n', {})).toBeUndefined();
    expect(resolveTuiShortcut('M', { meta: true })?.command).toBe('model');
    expect(resolveTuiShortcut('n', { ctrl: true, meta: true })).toBeUndefined();
  });

  it('has unique chords, discoverable command hints, and no hidden destructive shortcut', () => {
    const chords = tuiShortcuts.flatMap((entry) => entry.keys);
    expect(new Set(chords).size).toBe(chords.length);
    expect(shortcutHint('model')).toBe('Ctrl-P / Alt-M / Ctrl-M');
    expect(shortcutHint('new')).toContain('Ctrl-N');
    expect(shortcutHint('delete')).toBe('');
    expect(tuiShortcuts.some((entry) => entry.command.startsWith('delete'))).toBe(false);
    for (const entry of tuiShortcuts) {
      for (const chord of entry.keys) {
        const [modifier, character] = chord.split('-');
        const key = modifier === 'Ctrl' ? { ctrl: true } : { meta: true };
        expect(resolveTuiShortcut(character.toLowerCase(), key)).toBe(entry);
      }
    }
  });
});
