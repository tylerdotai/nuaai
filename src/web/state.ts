export interface WebEventRecord {
  id?: number;
  eventId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
  sessionId?: string;
  threadId?: string;
  runId?: string;
}

export type WebRunStatus = 'queued' | 'running' | 'action' | 'completed' | 'failed' | 'cancelled';

export interface WebToolActivity {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: number;
}

export interface WebRunProjection {
  runId: string;
  status: WebRunStatus;
  liveOutput: string;
  tools: WebToolActivity[];
  error?: string;
}

export interface WebRunSnapshotRecord {
  id: string;
  threadId: string;
  status: string;
  provider: string;
  model: string;
  output: string;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadRunState {
  version: 1;
  threadId: string;
  run: WebRunSnapshotRecord | null;
  activeRunId: string | null;
  queuedRunIds: string[];
  queuedRuns: Array<{ id: string; input: string; createdAt: number }>;
  events: WebEventRecord[];
  lastEventId: number;
}

export interface WebEventPage {
  events: WebEventRecord[];
  nextCursor: number;
  hasMore: boolean;
}

export interface SelectionIdentity {
  sessionId: string | null;
  threadId: string | null;
}

export interface SelectionLoad {
  generation: number;
  selection: SelectionIdentity;
  signal: AbortSignal;
}

export class SelectionLoadCoordinator {
  private generation = 0;
  private controller: AbortController | null = null;

  begin(selection: SelectionIdentity): SelectionLoad {
    this.controller?.abort();
    this.controller = new AbortController();
    this.generation += 1;
    return {
      generation: this.generation,
      selection,
      signal: this.controller.signal,
    };
  }

  isCurrent(load: SelectionLoad): boolean {
    return load.generation === this.generation && !load.signal.aborted;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.generation += 1;
  }
}

export function selectionLoadCanCommit(
  coordinator: SelectionLoadCoordinator,
  load: SelectionLoad,
  expected: SelectionIdentity,
  current: SelectionIdentity,
): boolean {
  return coordinator.isCurrent(load) && selectionIdentityMatches(expected, current);
}

export function selectionSnapshotCanCommit(
  coordinator: SelectionLoadCoordinator,
  load: SelectionLoad,
  expected: SelectionIdentity,
  current: SelectionIdentity,
  loadEpoch: number,
  currentEpoch: number,
): boolean {
  return loadEpoch === currentEpoch && selectionLoadCanCommit(coordinator, load, expected, current);
}

export function selectionIdentityMatches(
  expected: SelectionIdentity,
  current: SelectionIdentity,
): boolean {
  return expected.sessionId === current.sessionId && expected.threadId === current.threadId;
}

export type ActiveRunsByThread = Record<string, string | null>;
export type QueuedRunsByThread = Record<string, string[]>;
export type LiveOutputByRun = Record<string, string>;

export function liveOutputSnapshot(runState: ThreadRunState): LiveOutputByRun {
  const run = runState.run;
  return run && run.id === runState.activeRunId ? { [run.id]: run.output } : {};
}

export function reduceLiveOutputByRun(
  state: LiveOutputByRun,
  event: WebEventRecord,
): LiveOutputByRun {
  if (!event.runId) return state;
  if (event.type === 'run.started' || event.type === 'model.started')
    return { ...state, [event.runId]: '' };
  if (event.type === 'model.delta')
    return {
      ...state,
      [event.runId]: `${state[event.runId] ?? ''}${String(event.payload.text ?? '')}`,
    };
  if (terminalEvents.has(event.type)) {
    if (!(event.runId in state)) return state;
    const { [event.runId]: _removed, ...remaining } = state;
    return remaining;
  }
  return state;
}

const queuedRunEvents = new Set(['run.created', 'run.queued']);

export function reduceActiveRunsByThread(
  state: ActiveRunsByThread,
  event: WebEventRecord,
): ActiveRunsByThread {
  if (!event.threadId || !event.runId) return state;
  if (event.type === 'run.started') return { ...state, [event.threadId]: event.runId };
  if (queuedRunEvents.has(event.type) && !state[event.threadId])
    return { ...state, [event.threadId]: event.runId };
  if (terminalEvents.has(event.type) && state[event.threadId] === event.runId)
    return { ...state, [event.threadId]: null };
  return state;
}

export function activeRunForThread(
  state: ActiveRunsByThread,
  threadId: string | null,
): string | null {
  return threadId ? (state[threadId] ?? null) : null;
}

export function reduceQueuedRunsByThread(
  state: QueuedRunsByThread,
  event: WebEventRecord,
): QueuedRunsByThread {
  if (!event.threadId || !event.runId) return state;
  const current = state[event.threadId] ?? [];
  if (event.type === 'run.queued') {
    if (current.includes(event.runId)) return state;
    return { ...state, [event.threadId]: [...current, event.runId] };
  }
  if (event.type === 'run.started' || terminalEvents.has(event.type)) {
    const next = current.filter((runId) => runId !== event.runId);
    if (next.length === current.length) return state;
    if (next.length) return { ...state, [event.threadId]: next };
    const { [event.threadId]: _removed, ...remaining } = state;
    return remaining;
  }
  return state;
}

const terminalEvents = new Set(['run.completed', 'run.failed', 'run.cancelled']);

export function projectRunEvents(
  events: WebEventRecord[],
  preferredRunId?: string | null,
): WebRunProjection | null {
  const selectedRunId =
    preferredRunId ?? [...events].reverse().find((event) => Boolean(event.runId))?.runId;
  if (!selectedRunId) return null;

  let status: WebRunStatus = 'queued';
  let liveOutput = '';
  let error: string | undefined;
  const tools = new Map<string, WebToolActivity>();
  for (const event of events) {
    if (event.runId !== selectedRunId) continue;
    if (event.type === 'run.created' || event.type === 'run.queued') status = 'queued';
    else if (event.type === 'run.started') status = 'running';
    else if (event.type === 'model.started') {
      status = 'running';
      liveOutput = '';
    } else if (event.type === 'model.delta') {
      status = 'running';
      liveOutput += String(event.payload.text ?? '');
    } else if (event.type === 'tool.started') {
      status = 'action';
      const id = String(event.payload.id ?? event.id ?? tools.size);
      tools.set(id, {
        id,
        name: String(event.payload.name ?? 'Action'),
        status: 'running',
        createdAt: event.createdAt,
      });
    } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      status = 'running';
      const name = String(event.payload.name ?? 'Action');
      const legacyRunning = [...tools.values()].find(
        (tool) => tool.name === name && tool.status === 'running',
      );
      const id = String(event.payload.id ?? legacyRunning?.id ?? event.id ?? tools.size);
      const previous = tools.get(id);
      tools.set(id, {
        id,
        name: String(event.payload.name ?? previous?.name ?? 'Action'),
        status:
          event.type === 'tool.failed' || event.payload.isError === true ? 'failed' : 'completed',
        createdAt: event.createdAt,
      });
    }

    if (terminalEvents.has(event.type)) {
      status =
        event.type === 'run.completed'
          ? 'completed'
          : event.type === 'run.cancelled'
            ? 'cancelled'
            : 'failed';
      liveOutput = '';
      if (event.type === 'run.failed')
        error = String(event.payload.error ?? 'Run failed').slice(0, 500);
      for (const [id, tool] of tools) {
        if (tool.status === 'running')
          tools.set(id, {
            ...tool,
            status: event.type === 'run.completed' ? 'completed' : 'failed',
          });
      }
    }
  }

  return {
    runId: selectedRunId,
    status,
    liveOutput,
    tools: [...tools.values()],
    ...(error ? { error } : {}),
  };
}
