import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryVisibleInWorkspace } from '../src/memory/scope.js';

describe('memory workspace visibility', () => {
  const root = resolve('/workspace/project');

  it('retains legacy explicitly saved memory visibility without knowledge metadata', () => {
    expect(memoryVisibleInWorkspace({ pinned: true })).toBe(true);
    expect(memoryVisibleInWorkspace({}, root)).toBe(true);
  });

  it.each([null, false, 0, '', 'active'])(
    'rejects malformed knowledge metadata %j',
    (knowledge) => {
      expect(memoryVisibleInWorkspace({ knowledge }, root)).toBe(false);
    },
  );

  it('shares only active explicitly approved profile knowledge across workspaces', () => {
    const knowledge = { state: 'active', scope: 'profile', origin: 'explicit' };
    expect(memoryVisibleInWorkspace({ knowledge })).toBe(true);
    expect(memoryVisibleInWorkspace({ knowledge }, '/workspace/other')).toBe(true);
    expect(
      memoryVisibleInWorkspace({ knowledge: { ...knowledge, origin: 'automatic' } }, root),
    ).toBe(false);
    expect(memoryVisibleInWorkspace({ knowledge: { ...knowledge, state: 'reverted' } }, root)).toBe(
      false,
    );
  });

  it('requires an active workspace record and a matching normalized caller workspace', () => {
    const knowledge = { state: 'active', scope: 'workspace', workspaceRoot: root };
    expect(memoryVisibleInWorkspace({ knowledge }, `${root}/child/..`)).toBe(true);
    expect(memoryVisibleInWorkspace({ knowledge }, `${root}-other`)).toBe(false);
    expect(memoryVisibleInWorkspace({ knowledge }, `${root}/child`)).toBe(false);
    expect(memoryVisibleInWorkspace({ knowledge })).toBe(false);
    expect(memoryVisibleInWorkspace({ knowledge }, '')).toBe(false);
    for (const change of [
      { state: 'proposed' },
      { state: 'reverted' },
      { scope: 'unknown' },
      { workspaceRoot: undefined },
      { workspaceRoot: 42 },
    ]) {
      expect(memoryVisibleInWorkspace({ knowledge: { ...knowledge, ...change } }, root)).toBe(
        false,
      );
    }
  });
});
