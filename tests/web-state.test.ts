import { describe, expect, it } from 'vitest';

import { displayModel, displayProviderName } from '../src/web/format.js';
import {
  SelectionLoadCoordinator,
  type WebEventRecord,
  activeRunForThread,
  projectRunEvents,
  reduceActiveRunsByThread,
  reduceQueuedRunsByThread,
  selectionIdentityMatches,
  selectionLoadCanCommit,
  selectionSnapshotCanCommit,
} from '../src/web/state.js';

it('labels the Ollama-compatible provider as local in the product UI', () => {
  expect(displayProviderName('ollama')).toBe('Local');
  expect(displayModel({ name: 'ollama', model: 'nemotron' })).toBe('local · nemotron');
});

function event(
  id: number,
  runId: string,
  type: string,
  payload: Record<string, unknown> = {},
): WebEventRecord {
  return { id, runId, type, payload, createdAt: id };
}

describe('web run event projection', () => {
  it('clears streamed text when the selected run reaches a terminal state', () => {
    const projection = projectRunEvents([
      event(1, 'run-1', 'run.started'),
      event(2, 'run-1', 'model.delta', { text: 'One answer' }),
      event(3, 'run-1', 'run.completed', { output: 'One answer' }),
    ]);

    expect(projection).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      liveOutput: '',
    });
  });

  it('never combines deltas from different runs', () => {
    const projection = projectRunEvents([
      event(1, 'run-1', 'model.delta', { text: 'old' }),
      event(2, 'run-1', 'run.completed'),
      event(3, 'run-2', 'run.queued'),
      event(4, 'run-2', 'model.delta', { text: 'new' }),
    ]);

    expect(projection).toMatchObject({ runId: 'run-2', status: 'running', liveOutput: 'new' });
  });

  it('projects readable action states and retains failed outcomes', () => {
    const projection = projectRunEvents([
      event(1, 'run-1', 'run.started'),
      event(2, 'run-1', 'tool.started', { id: 'tool-1', name: 'workspace.read' }),
      event(3, 'run-1', 'tool.completed', {
        id: 'tool-1',
        name: 'workspace.read',
        isError: true,
      }),
      event(4, 'run-1', 'run.failed'),
    ]);

    expect(projection).toMatchObject({ status: 'failed', liveOutput: '' });
    expect(projection?.tools).toEqual([
      expect.objectContaining({ id: 'tool-1', name: 'workspace.read', status: 'failed' }),
    ]);
  });

  it('pairs legacy id-less tool events and renders the terminal failure reason', () => {
    const projection = projectRunEvents([
      event(1, 'run-1', 'run.started'),
      event(2, 'run-1', 'tool.started', { name: 'workspace.read' }),
      event(3, 'run-1', 'tool.completed', { name: 'workspace.read' }),
      event(4, 'run-1', 'tool.started', { name: 'workspace.read' }),
      event(5, 'run-1', 'tool.completed', { name: 'workspace.read' }),
      event(6, 'run-1', 'run.failed', { error: 'Run tool-call limit exceeded' }),
    ]);

    expect(projection).toMatchObject({
      status: 'failed',
      error: 'Run tool-call limit exceeded',
    });
    expect(projection?.tools).toHaveLength(2);
    expect(projection?.tools.every((tool) => tool.status === 'completed')).toBe(true);
  });

  it('returns a queued projection before the first event for a newly accepted run', () => {
    expect(projectRunEvents([], 'run-pending')).toEqual({
      runId: 'run-pending',
      status: 'queued',
      liveOutput: '',
      tools: [],
    });
  });
});

describe('web selection and thread-owned run state', () => {
  it('aborts stale selection loads and rejects their late commits', () => {
    const coordinator = new SelectionLoadCoordinator();
    const first = coordinator.begin({ sessionId: 'session-a', threadId: 'thread-a' });
    const second = coordinator.begin({ sessionId: 'session-b', threadId: 'thread-b' });

    expect(first.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);
    coordinator.cancel();
    expect(second.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(second)).toBe(false);
  });

  it('keeps background loads independent and rejects commits owned by an old selection', () => {
    const foreground = new SelectionLoadCoordinator();
    const background = new SelectionLoadCoordinator();
    const selectionA = { sessionId: 'session-a', threadId: 'thread-a' };
    const selectionB = { sessionId: 'session-b', threadId: 'thread-b' };
    const foregroundLoad = foreground.begin(selectionA);

    const backgroundLoad = background.begin(selectionA);
    expect(foregroundLoad.signal.aborted).toBe(false);
    expect(selectionLoadCanCommit(foreground, foregroundLoad, selectionA, selectionA)).toBe(true);
    expect(
      selectionSnapshotCanCommit(foreground, foregroundLoad, selectionA, selectionA, 1, 2),
    ).toBe(false);
    expect(
      selectionSnapshotCanCommit(background, backgroundLoad, selectionA, selectionA, 2, 2),
    ).toBe(true);
    expect(selectionLoadCanCommit(foreground, foregroundLoad, selectionA, selectionB)).toBe(false);
    expect(selectionIdentityMatches(selectionA, selectionA)).toBe(true);
    expect(selectionIdentityMatches(selectionA, selectionB)).toBe(false);

    foreground.begin(selectionB);
    expect(selectionLoadCanCommit(foreground, foregroundLoad, selectionA, selectionA)).toBe(false);
  });

  it('keeps active run ownership by thread when older terminal events arrive late', () => {
    const beforeTransfer = [
      { ...event(1, 'run-a1', 'run.started'), threadId: 'thread-a' },
      { ...event(2, 'run-b1', 'run.started'), threadId: 'thread-b' },
      { ...event(3, 'run-a2', 'run.queued'), threadId: 'thread-a' },
    ].reduce(reduceActiveRunsByThread, {});
    expect(activeRunForThread(beforeTransfer, 'thread-a')).toBe('run-a1');

    const state = [
      { ...event(4, 'run-a2', 'run.started'), threadId: 'thread-a' },
      { ...event(5, 'run-a1', 'run.completed'), threadId: 'thread-a' },
    ].reduce(reduceActiveRunsByThread, beforeTransfer);

    expect(activeRunForThread(state, 'thread-a')).toBe('run-a2');
    expect(activeRunForThread(state, 'thread-b')).toBe('run-b1');
    expect(activeRunForThread(state, null)).toBeNull();
  });

  it('deduplicates queued replay and removes a follow-up when execution starts', () => {
    const state = [
      { ...event(1, 'run-a1', 'run.queued'), threadId: 'thread-a' },
      { ...event(2, 'run-a1', 'run.queued'), threadId: 'thread-a' },
      { ...event(3, 'run-b1', 'run.queued'), threadId: 'thread-b' },
      { ...event(4, 'run-a1', 'run.started'), threadId: 'thread-a' },
      { ...event(5, 'run-a2', 'run.queued'), threadId: 'thread-a' },
    ].reduce(reduceQueuedRunsByThread, {});

    expect(state).toEqual({ 'thread-a': ['run-a2'], 'thread-b': ['run-b1'] });
  });
});
