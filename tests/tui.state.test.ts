import { describe, expect, it } from 'vitest';

import {
  type TuiEvent,
  initialTuiState,
  nextSelection,
  reduceTuiEvent,
  tuiApprovalFallbackIntervalMs,
  tuiArtifactLines,
  tuiMessagesFromPresentation,
  tuiReconnectDelayMs,
} from '../src/ui/tui-state.js';

describe('TUI event state', () => {
  it('preserves per-run tool activities even when an approval-paused turn has no answer yet', () => {
    const messages = tuiMessagesFromPresentation([
      {
        role: 'assistant',
        runId: 'paused-run',
        markdown: '',
        activities: [
          {
            items: [
              { id: 'call-1', name: 'workspace.write', status: 'running', target: 'notes.txt' },
            ],
          },
        ],
      },
    ]);
    expect(messages).toMatchObject([
      {
        runId: 'paused-run',
        tools: [{ id: 'call-1', name: 'workspace.write', status: 'running', target: 'notes.txt' }],
      },
    ]);
  });

  it('reconciles deleted selections to existing records instead of retaining stale IDs', () => {
    const previous = {
      ...initialTuiState,
      selectedSessionId: 'deleted-session',
      selectedThreadId: 'deleted-thread',
      activeRunId: 'old-run',
      stream: 'old answer',
    };
    const next = reduceTuiEvent(previous, {
      type: 'sessions.loaded',
      sessions: [{ id: 'remaining', title: 'Keep', status: 'active' }],
      threads: [{ id: 'remaining-thread', sessionId: 'remaining', title: 'Keep thread' }],
    });
    expect(next.selectedSessionId).toBe('remaining');
    expect(next.selectedThreadId).toBe('remaining-thread');
    expect(next.activeRunId).toBeNull();
    expect(next.stream).toBe('');
  });

  it('clears stream and tool activity immediately when switching threads, but not on same-thread refresh', () => {
    const state = {
      ...initialTuiState,
      selectedThreadId: 'old',
      activeRunId: 'old-run',
      stream: 'private old answer',
      tools: [{ name: 'read_file', status: 'running' as const }],
    };
    expect(reduceTuiEvent(state, { type: 'thread.selected', threadId: 'old' })).toEqual(state);
    const next = reduceTuiEvent(state, { type: 'thread.selected', threadId: 'new' });
    expect(next.stream).toBe('');
    expect(next.activeRunId).toBeNull();
    expect(next.tools).toEqual([]);
    expect(
      reduceTuiEvent(next, { type: 'model.delta', runId: 'old-run', text: 'late output' }).stream,
    ).toBe('');
  });

  it('reconciles the selected thread run without retaining another thread stream', () => {
    const running = reduceTuiEvent(initialTuiState, {
      type: 'run.started',
      runId: 'old-run',
      provider: 'codex',
      model: 'test',
    });
    const streamed = reduceTuiEvent(running, {
      type: 'model.delta',
      runId: 'old-run',
      text: 'old output',
    });
    const selected = reduceTuiEvent(streamed, { type: 'run.snapshot', activeRunId: null });
    expect(selected.activeRunId).toBeNull();
    expect(selected.stream).toBe('');
    const resumed = reduceTuiEvent(selected, { type: 'run.snapshot', activeRunId: 'new-run' });
    expect(resumed.activeRunId).toBe('new-run');
  });
  it('bounds reconnect backoff and keeps a low-frequency approval fallback', () => {
    expect([1, 2, 3, 4, 9].map(tuiReconnectDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000]);
    expect(tuiApprovalFallbackIntervalMs).toBe(15_000);
  });

  it('hydrates only user-visible messages from structured presentation', () => {
    expect(
      tuiMessagesFromPresentation([
        { role: 'user', markdown: 'Prompt' },
        { role: 'assistant', markdown: 'Final answer' },
        { role: 'tool', markdown: 'hidden tool result' },
        { role: 'assistant', markdown: '   ' },
      ]),
    ).toEqual([
      { role: 'user', content: 'Prompt' },
      { role: 'assistant', content: 'Final answer' },
    ]);
  });

  it('hydrates durable artifact and citation visibility without exposing unsupported kinds', () => {
    expect(
      tuiMessagesFromPresentation([
        {
          role: 'assistant',
          markdown: 'Done',
          artifacts: [
            {
              type: 'artifact',
              kind: 'file',
              title: 'report.txt',
              downloadUrl: 'api/runs/run-1/artifacts/artifact-1/download',
            },
            {
              type: 'unsupported',
              sourceKind: 'future-kind',
              label: 'This run artifact is not supported in this NUAAI version.',
            },
          ],
          citations: [{ id: 'cite-1', title: 'Source', url: 'https://example.com/source' }],
        },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: 'Done',
        artifacts: [
          {
            type: 'artifact',
            kind: 'file',
            title: 'report.txt',
            downloadUrl: 'api/runs/run-1/artifacts/artifact-1/download',
          },
          {
            type: 'unsupported',
            title: 'This run artifact is not supported in this NUAAI version.',
          },
        ],
        citations: [{ title: 'Source', url: 'https://example.com/source' }],
      },
    ]);
    expect(
      JSON.stringify(
        tuiMessagesFromPresentation([
          {
            role: 'assistant',
            markdown: 'Done',
            artifacts: [
              {
                type: 'unsupported',
                sourceKind: 'future-kind',
                label: 'This run artifact is not supported in this NUAAI version.',
              },
            ],
            citations: [],
          },
        ]),
      ),
    ).not.toContain('future-kind');
  });

  it('formats artifact and citation lines for the visible conversation panel', () => {
    expect(
      tuiArtifactLines({
        role: 'assistant',
        content: 'Done',
        artifacts: [
          {
            type: 'artifact',
            kind: 'file',
            title: 'report.txt',
            downloadUrl: 'api/runs/run-1/artifacts/artifact-1/download',
          },
          { type: 'unsupported', title: 'This run artifact is not supported.' },
        ],
        citations: [{ title: 'Source', url: 'https://example.com/source' }],
      }),
    ).toEqual([
      'Artifact: report.txt [file] · api/runs/run-1/artifacts/artifact-1/download',
      'Artifact: This run artifact is not supported.',
      'Citation: Source · https://example.com/source',
    ]);
  });

  it('wraps session and thread selection in both directions', () => {
    expect(nextSelection('session-2', ['session-1', 'session-2', 'session-3'], 1)).toBe(
      'session-3',
    );
    expect(nextSelection('session-1', ['session-1', 'session-2', 'session-3'], -1)).toBe(
      'session-3',
    );
    expect(nextSelection(null, ['session-1', 'session-2'], 1)).toBe('session-1');
    expect(nextSelection('missing', [], 1)).toBeNull();
  });

  it('hydrates sessions and selects the first resumable thread', () => {
    const next = reduceTuiEvent(initialTuiState, {
      type: 'sessions.loaded',
      sessions: [
        { id: 'session-1', title: 'First', status: 'active' },
        { id: 'session-2', title: 'Second', status: 'idle' },
      ],
      threads: [{ id: 'thread-1', sessionId: 'session-1', title: 'Main' }],
    });

    expect(next.sessions).toHaveLength(2);
    expect(next.selectedSessionId).toBe('session-1');
    expect(next.selectedThreadId).toBe('thread-1');
    expect(next.connection).toBe('connected');
  });

  it('keeps only the current model attempt and tool activity until the run completes', () => {
    const events: TuiEvent[] = [
      { type: 'run.started', runId: 'run-1', provider: 'deterministic', model: 'local-test' },
      { type: 'model.started', runId: 'run-1' },
      { type: 'model.delta', runId: 'run-1', text: 'discarded draft' },
      { type: 'tool.started', runId: 'run-1', name: 'workspace.list' },
      { type: 'model.started', runId: 'run-1' },
      { type: 'model.delta', runId: 'run-1', text: 'world' },
      { type: 'tool.completed', runId: 'run-1', name: 'workspace.list' },
    ];
    const active = events.reduce(reduceTuiEvent, initialTuiState);

    expect(active.activeRunId).toBe('run-1');
    expect(active.provider).toEqual({ name: 'deterministic', model: 'local-test' });
    expect(active.stream).toBe('world');
    expect(active.tools).toEqual([{ name: 'workspace.list', status: 'completed' }]);

    const completed = reduceTuiEvent(active, { type: 'run.completed', runId: 'run-1' });
    expect(completed.activeRunId).toBeNull();
    expect(completed.stream).toBe('');
  });

  it('hydrates navigable daemon catalog surfaces without exposing secret values', () => {
    const next = reduceTuiEvent(initialTuiState, {
      type: 'catalog.loaded',
      active: { name: 'ollama', model: 'qwen3.5:latest' },
      tasks: [{ id: 'task-1', status: 'queued', kind: 'scheduled', scheduleId: 'schedule-1' }],
      schedules: [{ id: 'schedule-1', name: 'Morning', enabled: true, nextRunAt: null }],
      memories: [{ id: 'memory-1', content: 'A durable fact', hasEmbedding: true }],
      skills: [{ name: 'workspace', description: 'Workspace tools', source: 'local' }],
      plugins: [{ name: 'calendar', version: '1.0.0', enabled: true, capabilities: ['network'] }],
      providers: [{ name: 'ollama', available: true, detail: 'ready' }],
      secretNames: ['OLLAMA_API_KEY'],
    });

    expect(next.tasks[0]?.status).toBe('queued');
    expect(next.schedules[0]?.name).toBe('Morning');
    expect(next.memories[0]?.content).toBe('A durable fact');
    expect(next.skills[0]?.name).toBe('workspace');
    expect(next.plugins[0]?.capabilities).toEqual(['network']);
    expect(next.providers[0]?.available).toBe(true);
    expect(next.provider).toEqual({ name: 'ollama', model: 'qwen3.5:latest' });
    expect(next.secretNames).toEqual(['OLLAMA_API_KEY']);
    expect(JSON.stringify(next)).not.toContain('secret-value');

    const navigated = reduceTuiEvent(next, { type: 'view.changed', view: 'plugins' });
    expect(navigated.view).toBe('plugins');
  });

  it('selects a session and thread without losing the active catalog', () => {
    const hydrated = reduceTuiEvent(initialTuiState, {
      type: 'sessions.loaded',
      sessions: [
        { id: 'session-1', title: 'First', status: 'active' },
        { id: 'session-2', title: 'Second', status: 'idle' },
      ],
      threads: [
        { id: 'thread-1', sessionId: 'session-1', title: 'Main' },
        { id: 'thread-2', sessionId: 'session-2', title: 'Other' },
      ],
    });
    const selectedSession = reduceTuiEvent(hydrated, {
      type: 'session.selected',
      sessionId: 'session-2',
    });
    expect(selectedSession.selectedSessionId).toBe('session-2');
    expect(selectedSession.selectedThreadId).toBe('thread-2');
    const selectedThread = reduceTuiEvent(selectedSession, {
      type: 'thread.selected',
      threadId: 'thread-1',
    });
    expect(selectedThread.selectedThreadId).toBe('thread-1');
    expect(selectedThread.sessions).toHaveLength(2);
  });

  it('keeps cancellation, retry, connection, and error state visible', () => {
    const cancelled = reduceTuiEvent(initialTuiState, {
      type: 'run.cancelled',
      runId: 'run-2',
    });
    const retrying = reduceTuiEvent(cancelled, {
      type: 'task.retried',
      taskId: 'task-1',
      attempt: 2,
      maxAttempts: 3,
    });
    const disconnected = reduceTuiEvent(retrying, {
      type: 'connection.changed',
      status: 'disconnected',
      error: 'daemon unavailable',
    });

    expect(disconnected.lastRunStatus).toBe('cancelled');
    expect(disconnected.retry).toEqual({ taskId: 'task-1', attempt: 2, maxAttempts: 3 });
    expect(disconnected.connection).toBe('disconnected');
    expect(disconnected.error).toBe('daemon unavailable');
  });
});
