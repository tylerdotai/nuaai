export type TuiConnection = 'connecting' | 'connected' | 'disconnected';
export type TuiView =
  | 'conversation'
  | 'tasks'
  | 'schedules'
  | 'memory'
  | 'skills'
  | 'plugins'
  | 'settings'
  | 'help'
  | 'palette';

export interface TuiSession {
  id: string;
  title: string;
  status: string;
}

export interface TuiThread {
  id: string;
  sessionId: string;
  title: string;
}

export type TuiConversationArtifact =
  | {
      type: 'artifact';
      kind: string;
      title: string;
      downloadUrl?: string;
      externalUrl?: string;
    }
  | { type: 'unsupported'; title: string };

export interface TuiConversationMessage {
  id?: string;
  runId?: string;
  tools?: TuiToolActivity[];
  role: string;
  content: string;
  artifacts?: TuiConversationArtifact[];
  citations?: Array<{ title: string; url: string }>;
}

export function tuiArtifactLines(message: TuiConversationMessage): string[] {
  return [
    ...(message.artifacts ?? []).map((artifact) =>
      artifact.type === 'unsupported'
        ? `Artifact: ${artifact.title}`
        : `Artifact: ${artifact.title} [${artifact.kind}]${artifact.downloadUrl ? ` · ${artifact.downloadUrl}` : artifact.externalUrl ? ` · ${artifact.externalUrl}` : ''}`,
    ),
    ...(message.citations ?? []).map((citation) => `Citation: ${citation.title} · ${citation.url}`),
  ];
}

export function tuiMessagesFromPresentation(
  messages: Array<{
    id?: string;
    runId?: string;
    activities?: Array<{ items: TuiToolActivity[] }>;
    role: string;
    markdown: string;
    artifacts?: Array<{
      type: string;
      sourceKind?: string;
      kind?: string;
      title?: string;
      downloadUrl?: string;
      externalUrl?: string;
      label?: string;
    }>;
    citations?: Array<{ id?: string; title: string; url: string }>;
  }>,
): TuiConversationMessage[] {
  return messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        (message.markdown.trim() || message.activities?.some((group) => group.items.length)),
    )
    .map((message) => {
      const artifacts: TuiConversationArtifact[] = (message.artifacts ?? []).flatMap(
        (artifact): TuiConversationArtifact[] => {
          if (artifact.type === 'unsupported')
            return artifact.label ? [{ type: 'unsupported' as const, title: artifact.label }] : [];
          if (artifact.type !== 'artifact' || !artifact.kind || !artifact.title) return [];
          return [
            {
              type: 'artifact' as const,
              kind: artifact.kind,
              title: artifact.title,
              ...(artifact.downloadUrl ? { downloadUrl: artifact.downloadUrl } : {}),
              ...(artifact.externalUrl ? { externalUrl: artifact.externalUrl } : {}),
            },
          ];
        },
      );
      const citations = (message.citations ?? []).map(({ title, url }) => ({ title, url }));
      return {
        role: message.role,
        content: message.markdown,
        ...(message.id ? { id: message.id } : {}),
        ...(message.runId ? { runId: message.runId } : {}),
        ...(message.activities?.some((group) => group.items.length)
          ? { tools: message.activities.flatMap((group) => group.items) }
          : {}),
        ...(artifacts.length ? { artifacts } : {}),
        ...(citations.length ? { citations } : {}),
      };
    });
}

export interface TuiToolActivity {
  id?: string;
  detail?: string;
  target?: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
}

export interface TuiTask {
  id: string;
  status: string;
  kind: string;
  scheduleId: string | null;
}

export interface TuiSchedule {
  id: string;
  name: string;
  type?: string;
  expression?: string;
  agentInput?: string;
  enabled: boolean;
  nextRunAt: number | null;
}

export interface TuiMemory {
  metadata?: Record<string, unknown>;
  id: string;
  content: string;
  hasEmbedding: boolean;
}

export interface TuiSkill {
  name: string;
  enabled?: boolean;
  description: string;
  source: string;
}

export interface TuiPlugin {
  name: string;
  version: string;
  enabled: boolean;
  capabilities: string[];
}

export interface TuiProviderHealth {
  name: string;
  available: boolean;
  detail: string;
  models?: string[];
}

export interface TuiRetryState {
  taskId: string;
  attempt: number;
  maxAttempts: number;
}

export interface TuiApproval {
  id: string;
  runId: string;
  threadId: string;
  toolName: string;
  status: string;
  payloadHash: string;
  target: string;
  risk: string;
  preview: {
    version: 1;
    kind: string;
    summary: string;
    fields: Array<{ label: string; value: string; format?: 'code' }>;
    context: { source: string; client: string; sessionId?: string };
  };
  providerOwned: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface TuiState {
  connection: TuiConnection;
  error: string | null;
  view: TuiView;
  sessions: TuiSession[];
  threads: TuiThread[];
  selectedSessionId: string | null;
  selectedThreadId: string | null;
  activeRunId: string | null;
  provider: { name: string; model: string } | null;
  providers: TuiProviderHealth[];
  tasks: TuiTask[];
  schedules: TuiSchedule[];
  memories: TuiMemory[];
  skills: TuiSkill[];
  plugins: TuiPlugin[];
  secretNames: string[];
  stream: string;
  tools: TuiToolActivity[];
  lastRunStatus: 'completed' | 'failed' | 'cancelled' | null;
  retry: TuiRetryState | null;
  approvals: TuiApproval[];
  catalogErrors?: string[];
}

export type TuiEvent =
  | { type: 'sessions.loaded'; sessions: TuiSession[]; threads: TuiThread[] }
  | {
      type: 'catalog.loaded';
      active: { name: string; model: string } | null;
      errors?: string[];
      tasks: TuiTask[];
      schedules: TuiSchedule[];
      memories: TuiMemory[];
      skills: TuiSkill[];
      plugins: TuiPlugin[];
      providers: TuiProviderHealth[];
      secretNames: string[];
      approvals?: TuiApproval[];
    }
  | { type: 'run.snapshot'; activeRunId: string | null }
  | { type: 'run.hydrated'; activeRunId: string | null; events: TuiEvent[] }
  | { type: 'view.changed'; view: TuiView }
  | { type: 'session.selected'; sessionId: string }
  | { type: 'thread.selected'; threadId: string }
  | { type: 'connection.changed'; status: TuiConnection; error?: string }
  | { type: 'run.started'; runId: string; provider: string; model: string }
  | { type: 'model.started'; runId: string }
  | { type: 'model.delta'; runId: string; text: string }
  | { type: 'tool.started'; runId: string; name: string; id?: string; detail?: string }
  | { type: 'tool.completed'; runId: string; name: string; id?: string; detail?: string }
  | { type: 'tool.failed'; runId: string; name: string; id?: string; detail?: string }
  | { type: 'run.completed'; runId: string }
  | { type: 'run.failed'; runId: string; error?: string }
  | { type: 'run.cancelled'; runId: string }
  | { type: 'task.retried'; taskId: string; attempt: number; maxAttempts: number };

export function nextSelection(
  current: string | null,
  ids: string[],
  direction: -1 | 1,
): string | null {
  if (ids.length === 0) return null;
  const index = current ? ids.indexOf(current) : -1;
  const nextIndex = index === -1 ? 0 : (index + direction + ids.length) % ids.length;
  return ids[nextIndex] ?? null;
}

export const tuiApprovalFallbackIntervalMs = 15_000;

export function tuiReconnectDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 10_000);
}

export const initialTuiState: TuiState = {
  connection: 'connecting',
  error: null,
  view: 'conversation',
  sessions: [],
  threads: [],
  selectedSessionId: null,
  selectedThreadId: null,
  activeRunId: null,
  provider: null,
  providers: [],
  tasks: [],
  schedules: [],
  memories: [],
  skills: [],
  plugins: [],
  secretNames: [],
  stream: '',
  tools: [],
  lastRunStatus: null,
  retry: null,
  approvals: [],
};

export function reduceTuiEvent(state: TuiState, event: TuiEvent): TuiState {
  switch (event.type) {
    case 'sessions.loaded': {
      const selectedSessionId = event.sessions.some(
        (session) => session.id === state.selectedSessionId,
      )
        ? state.selectedSessionId
        : (event.sessions[0]?.id ?? null);
      const availableThreads = event.threads.filter(
        (thread) => thread.sessionId === selectedSessionId,
      );
      const selectedThreadId = availableThreads.some(
        (thread) => thread.id === state.selectedThreadId,
      )
        ? state.selectedThreadId
        : (availableThreads[0]?.id ?? null);
      return {
        ...state,
        sessions: event.sessions,
        threads: event.threads,
        ...(selectedThreadId !== state.selectedThreadId
          ? { activeRunId: null, stream: '', tools: [], lastRunStatus: null, retry: null }
          : {}),
        selectedSessionId,
        selectedThreadId,
        connection: 'connected',
        error: null,
      };
    }
    case 'catalog.loaded':
      return {
        ...state,
        provider: event.active,
        catalogErrors: event.errors ?? [],
        tasks: event.tasks,
        schedules: event.schedules,
        memories: event.memories,
        skills: event.skills,
        plugins: event.plugins,
        providers: event.providers,
        secretNames: event.secretNames,
        approvals: event.approvals ?? state.approvals,
      };
    case 'run.hydrated': {
      let hydrated: TuiState = {
        ...state,
        activeRunId: event.activeRunId,
        stream: '',
        tools: [],
        lastRunStatus: null,
        retry: null,
      };
      for (const entry of event.events) hydrated = reduceTuiEvent(hydrated, entry);
      return hydrated;
    }
    case 'run.snapshot':
      return state.activeRunId === event.activeRunId
        ? state
        : { ...state, activeRunId: event.activeRunId, stream: '', tools: [] };
    case 'view.changed':
      return { ...state, view: event.view };
    case 'session.selected': {
      const selectedThreadId =
        state.threads.find((thread) => thread.sessionId === event.sessionId)?.id ?? null;
      const next = { ...state, selectedSessionId: event.sessionId, selectedThreadId };
      return selectedThreadId === state.selectedThreadId
        ? next
        : { ...next, activeRunId: null, stream: '', tools: [], lastRunStatus: null, retry: null };
    }
    case 'thread.selected':
      return state.selectedThreadId === event.threadId
        ? state
        : {
            ...state,
            selectedThreadId: event.threadId,
            activeRunId: null,
            stream: '',
            tools: [],
            lastRunStatus: null,
            retry: null,
          };
    case 'connection.changed':
      return { ...state, connection: event.status, error: event.error ?? null };
    case 'run.started':
      return {
        ...state,
        activeRunId: event.runId,
        provider: { name: event.provider, model: event.model },
        stream: '',
        tools: [],
        lastRunStatus: null,
        error: null,
      };
    case 'model.started':
      return event.runId === state.activeRunId ? { ...state, stream: '' } : state;
    case 'model.delta':
      return event.runId === state.activeRunId
        ? { ...state, stream: `${state.stream}${event.text}` }
        : state;
    case 'tool.started':
      return event.runId === state.activeRunId
        ? {
            ...state,
            tools: [
              ...state.tools,
              { name: event.name, status: 'running', ...(event.id ? { id: event.id } : {}) },
            ],
          }
        : state;
    case 'tool.completed':
    case 'tool.failed': {
      if (event.runId !== state.activeRunId) return state;
      const status = event.type === 'tool.completed' ? 'completed' : 'failed';
      const index = state.tools.findIndex(
        (tool) =>
          (event.id ? tool.id === event.id : tool.name === event.name) && tool.status === 'running',
      );
      const completed: TuiToolActivity = {
        name: event.name,
        status,
        ...(event.id ? { id: event.id } : {}),
        ...(event.detail ? { detail: event.detail } : {}),
      };
      if (index === -1) return { ...state, tools: [...state.tools, completed] };
      const tools = [...state.tools];
      tools[index] = { ...tools[index], ...completed };
      return { ...state, tools };
    }
    case 'run.completed':
      return event.runId === state.activeRunId
        ? { ...state, activeRunId: null, stream: '', lastRunStatus: 'completed' }
        : state;
    case 'run.failed':
      return event.runId === state.activeRunId
        ? {
            ...state,
            activeRunId: null,
            lastRunStatus: 'failed',
            error: event.error ?? 'Run failed',
          }
        : state;
    case 'run.cancelled':
      return event.runId === state.activeRunId || state.activeRunId === null
        ? { ...state, activeRunId: null, lastRunStatus: 'cancelled' }
        : state;
    case 'task.retried':
      return {
        ...state,
        retry: { taskId: event.taskId, attempt: event.attempt, maxAttempts: event.maxAttempts },
      };
  }
}
