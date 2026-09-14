import { describe, expect, it } from 'vitest';

import {
  capabilitySummary,
  composerAction,
  draftStorageKey,
  resolveComposerCommand,
  textareaHeight,
} from '../src/web/composer.js';

describe('agent composer behavior', () => {
  it('keeps Send, Queue, and Stop in one action position based on input and run state', () => {
    expect(composerAction({ input: '', activeRunId: null })).toBe('disabled');
    expect(composerAction({ input: '  hello  ', activeRunId: null })).toBe('send');
    expect(composerAction({ input: '', activeRunId: 'run-a' })).toBe('stop');
    expect(composerAction({ input: 'follow up', activeRunId: 'run-a' })).toBe('queue');
  });

  it('uses encoded thread-specific draft keys without storing pairing material', () => {
    expect(draftStorageKey('thread/a?token=secret')).toBe(
      'nuaai:draft:thread%2Fa%3Ftoken%3Dsecret',
    );
    expect(draftStorageKey(null)).toBeNull();
  });

  it('resolves only exact supported slash commands', () => {
    expect(resolveComposerCommand('/new')).toBe('new-session');
    expect(resolveComposerCommand(' /refresh ')).toBe('refresh');
    expect(resolveComposerCommand('/memory')).toBe('memory');
    expect(resolveComposerCommand('/automate')).toBe('automations');
    expect(resolveComposerCommand('/system')).toBe('system');
    expect(resolveComposerCommand('/new explain this')).toBeNull();
    expect(resolveComposerCommand('/unknown')).toBeNull();
  });

  it('reports the real permission surface instead of a generic capability claim', () => {
    expect(capabilitySummary('read-only')).toEqual({
      label: 'Read only',
      capabilities: ['Read workspace', 'Search memory', 'Inspect run history'],
    });
    expect(capabilitySummary('operator')).toEqual({
      label: 'Operator',
      capabilities: [
        'Read workspace',
        'Write workspace',
        'Run approved commands',
        'Search memory',
        'Inspect run history',
      ],
    });
  });

  it('auto-grows within usable minimum and maximum bounds', () => {
    expect(textareaHeight(20)).toBe(44);
    expect(textareaHeight(112)).toBe(112);
    expect(textareaHeight(900)).toBe(240);
    expect(textareaHeight(900, true)).toBe(520);
  });
});
