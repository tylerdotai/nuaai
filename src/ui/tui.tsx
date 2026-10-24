import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import { Box, Text, useApp, useInput, useStdin, useStdout, useWindowSize } from 'ink';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { WebSocket } from 'ws';
import { commandMatches, editDraft, parseCommand, tuiCommands } from './tui-commands.js';
import {
  type ManagementAction,
  confirmationMenu,
  managementList,
  managementMenu,
  managementRequest,
} from './tui-management.js';
import { type PickerState, TuiPicker, pickerMatches } from './tui-picker.js';
import {
  defaultTuiPreferences,
  loadTuiPreferences,
  saveTuiPreferences,
} from './tui-preferences.js';

import { type SessionIdentityStatus, identityStatusLines } from '../core/identity.js';
import type { Scheduler } from '../core/scheduler.js';
import type { LearningStatus } from '../memory/learning.js';
import { webSocketCloseDisposition } from '../web/auth.js';
import { approvalModeMenu } from './tui-approval-menu.js';
import { mergeTuiMessages } from './tui-client-history.js';
import { useTuiComposer } from './tui-composer.js';
import { TuiConversation } from './tui-conversation.js';
import { TuiEditor } from './tui-editor.js';
import { attachmentPaths, readAttachment } from './tui-files.js';
import { TuiScheduleForm, scheduleFields, scheduleForm, scheduleFromForm } from './tui-forms.js';
import { learningModeMenu } from './tui-learning-menu.js';
import { terminalText } from './tui-markdown.js';
import { useTuiNavigation } from './tui-navigation.js';
import {
  clipboardSequence,
  codeBlocks,
  exportConversation,
  openOutput,
  saveArtifact,
} from './tui-outputs.js';
import { type TuiScheduleDraft, parseScheduleCommand } from './tui-schedule.js';
import { resolveTuiShortcut, shortcutHint, tuiKeyHelp, tuiShortcuts } from './tui-shortcuts.js';
import {
  type TuiConversationMessage,
  type TuiEvent,
  type TuiView,
  initialTuiState,
  nextSelection,
  reduceTuiEvent,
  tuiApprovalFallbackIntervalMs,
  tuiMessagesFromPresentation,
  tuiReconnectDelayMs,
} from './tui-state.js';
import { TuiRuntimeStatus, type TuiRuntimeSummary } from './tui-status.js';
import { TuiViewport } from './tui-viewport.js';

interface TuiProps {
  root?: string;
  workspaceRoot?: string;
  baseUrl: string;
  token: string;
}
interface DaemonEvent {
  id?: number;
  type: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  taskId?: string;
  payload?: Record<string, unknown>;
}
interface RunSnapshot {
  activeRunId: string | null;
  lastEventId?: number;
  events?: DaemonEvent[];
}
interface Session {
  sourceKey?: string;
  id: string;
  title: string;
  status: string;
}
interface Thread {
  id: string;
  title: string;
}

function toTuiEvent(value: {
  type: string;
  runId?: string;
  taskId?: string;
  payload?: Record<string, unknown>;
}): TuiEvent | null {
  const payload = value.payload ?? {};
  const runId = value.runId ?? (typeof payload.runId === 'string' ? payload.runId : undefined);
  if (value.type === 'run.started' && runId)
    return {
      type: 'run.started',
      runId,
      provider: typeof payload.provider === 'string' ? payload.provider : 'unknown',
      model: typeof payload.model === 'string' ? payload.model : 'unknown',
    };
  if (value.type === 'model.started' && runId) return { type: 'model.started', runId };
  if (value.type === 'model.delta' && runId && typeof payload.text === 'string')
    return { type: 'model.delta', runId, text: payload.text };
  if (value.type === 'tool.started' && runId && typeof payload.name === 'string')
    return {
      type: 'tool.started',
      runId,
      name: payload.name,
      id: typeof payload.id === 'string' ? payload.id : undefined,
      detail: undefined,
    };
  if (value.type === 'tool.completed' && runId && typeof payload.name === 'string')
    return {
      type: 'tool.completed',
      runId,
      name: payload.name,
      id: typeof payload.id === 'string' ? payload.id : undefined,
      detail: undefined,
    };
  if (value.type === 'tool.failed' && runId && typeof payload.name === 'string')
    return {
      type: 'tool.failed',
      runId,
      name: payload.name,
      id: typeof payload.id === 'string' ? payload.id : undefined,
      detail: typeof payload.error === 'string' ? payload.error : undefined,
    };
  if (value.type === 'run.completed' && runId) return { type: 'run.completed', runId };
  if (value.type === 'run.cancelled' && runId) return { type: 'run.cancelled', runId };
  if (value.type === 'run.failed' && runId)
    return {
      type: 'run.failed',
      runId,
      error: typeof payload.error === 'string' ? payload.error : undefined,
    };
  if (value.type === 'task.retried' && value.taskId)
    return {
      type: 'task.retried',
      taskId: value.taskId,
      attempt: typeof payload.attempt === 'number' ? payload.attempt : 0,
      maxAttempts: typeof payload.maxAttempts === 'number' ? payload.maxAttempts : 0,
    };
  return null;
}

async function request<T>(
  baseUrl: string,
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(15_000),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...options.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}

async function loadConversationPage(
  baseUrl: string,
  token: string,
  threadId: string,
  before?: number,
): Promise<{ messages: TuiConversationMessage[]; nextCursor: number; hasMore: boolean }> {
  const presentation = await request<{
    nextCursor?: number;
    hasMore?: boolean;
    messages: Array<{
      id?: string;
      runId?: string;
      activities?: Array<{ items: import('./tui-state.js').TuiToolActivity[] }>;
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
    }>;
  }>(
    baseUrl,
    token,
    `/api/threads/${threadId}/presentation${before === undefined ? '' : `?before=${before}&limit=100`}`,
  );
  return {
    messages: tuiMessagesFromPresentation(presentation.messages),
    nextCursor: presentation.nextCursor ?? 0,
    hasMore: presentation.hasMore ?? false,
  };
}

type Catalog = Extract<TuiEvent, { type: 'catalog.loaded' }>;
async function fetchCatalog(
  baseUrl: string,
  token: string,
  previous: Catalog,
  onUpdate: (catalog: Catalog, path: string) => void,
): Promise<Catalog> {
  const errors: string[] = [];
  let catalog = { ...previous, errors };
  const resource = async <T,>(
    path: string,
    fallback: T,
    project: (value: T) => Partial<Catalog>,
  ): Promise<void> => {
    let update = project(fallback);
    try {
      update = project(await request<T>(baseUrl, token, path));
    } catch (cause) {
      errors.push(
        `${path.split('/').at(-1)?.split('?')[0]}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    catalog = { ...catalog, ...update, errors: [...errors] };
    onUpdate(catalog, path);
  };
  await Promise.all([
    resource('/api/tasks', { tasks: previous.tasks }, (value) => ({ tasks: value.tasks })),
    resource('/api/schedules', { schedules: previous.schedules }, (value) => ({
      schedules: value.schedules,
    })),
    resource('/api/memory', { memories: previous.memories }, (value) => ({
      memories: value.memories,
    })),
    resource('/api/skills', { skills: previous.skills }, (value) => ({
      skills: value.skills.map((skill) => ({ ...skill, source: skill.source ?? 'daemon' })),
    })),
    resource<{
      plugins: Array<{ name: string; version: string; capabilities: string[] }>;
      health: Array<{ name: string; enabled: boolean }>;
    }>('/api/plugins', { plugins: previous.plugins, health: previous.plugins }, (value) => ({
      plugins: value.plugins.map((plugin) => ({
        ...plugin,
        enabled: value.health.find((health) => health.name === plugin.name)?.enabled ?? false,
      })),
    })),
    resource(
      '/api/providers',
      { active: previous.active, providers: previous.providers },
      (value) => ({ active: value.active, providers: value.providers }),
    ),
    resource('/api/secrets', { names: previous.secretNames }, (value) => ({
      secretNames: value.names,
    })),
    resource('/api/approvals?status=pending', { approvals: previous.approvals ?? [] }, (value) => ({
      approvals: value.approvals,
    })),
  ]);
  return catalog;
}

export function Tui({
  baseUrl,
  token,
  root = homedir(),
  workspaceRoot = root,
}: TuiProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const outputContext = useRef<{ threadId: string; messages: TuiConversationMessage[] } | null>(
    null,
  );
  const { isRawModeSupported } = useStdin();
  const { rows, columns } = useWindowSize();
  const [historyExtent, setHistoryExtent] = useState(0);
  const [panelOffset, setPanelOffset] = useState(0);
  const [panelExtent, setPanelExtent] = useState(0);
  const [tuiState, dispatch] = useReducer(reduceTuiEvent, initialTuiState);
  const { sessions, threads, stream } = tuiState;
  const learningRef = useRef<LearningStatus | null>(null);
  const catalogRef = useRef<Catalog>({
    type: 'catalog.loaded',
    active: null,
    tasks: [],
    schedules: [],
    memories: [],
    skills: [],
    plugins: [],
    providers: [],
    secretNames: [],
    approvals: [],
  });
  const catalogFlight = useRef<Promise<Catalog> | null>(null);
  const catalogGeneration = useRef(0);
  const loadCatalog = useCallback(
    (url: string, credential: string, force = true, resource?: string): Promise<Catalog> => {
      if (!force && catalogFlight.current) return catalogFlight.current;
      const generation = ++catalogGeneration.current;
      let resourceCompleted: (path: string) => void = () => {};
      const ready = resource
        ? new Promise<Catalog>((resolve, reject) => {
            resourceCompleted = (path) => {
              if (path !== resource) return;
              if (!mounted.current || generation !== catalogGeneration.current)
                reject(new Error('Catalog changed while loading; retry this command.'));
              else resolve(catalogRef.current);
            };
          })
        : null;
      const pending = fetchCatalog(url, credential, catalogRef.current, (catalog, path) => {
        if (mounted.current && generation === catalogGeneration.current) {
          catalogRef.current = catalog;
          dispatch(catalog);
        }
        resourceCompleted(path);
      })
        .then(() => catalogRef.current)
        .finally(() => {
          if (generation === catalogGeneration.current) catalogFlight.current = null;
        });
      catalogFlight.current = pending;
      return ready ? Promise.race([ready, pending]) : pending;
    },
    [],
  );
  const [requestError, setError] = useState<string | null>(null);
  const composer = useTuiComposer(
    root,
    workspaceRoot === root ? baseUrl : `${baseUrl}#workspace=${resolve(workspaceRoot)}`,
    setError,
  );
  const [sessionIdentity, setSessionIdentity] = useState<SessionIdentityStatus | null>(null);
  const [sessionPolicy, setSessionPolicy] = useState<{
    sessionId: string;
    mode: string;
    grants: Array<{ tool: string; target: string }>;
  } | null>(null);
  const policySequence = useRef(0);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const identityReadSequence = useRef(0);
  const errors = [
    ...new Set(
      [composer.recoveryError, requestError].filter((error): error is string => error !== null),
    ),
  ];
  const { activate: activateComposer, setDraft: setComposerDraft } = composer;
  const carryDraft = useRef(false);
  const selectedSessionRef = useRef<string | null>(composer.selection.sessionId);
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<TuiConversationMessage[]>([]);
  const historyPage = useRef<{ threadId: string | null; nextCursor: number; hasMore: boolean }>({
    threadId: null,
    nextCursor: 0,
    hasMore: false,
  });
  const olderFlight = useRef<number | null>(null);
  const [searchFocus, setSearchFocus] = useState<{ index: number; revision: number }>();
  const searchResults = useRef<{ threadId: string; indices: number[]; position: number } | null>(
    null,
  );
  const navigation = useTuiNavigation(tuiState.view, (view) =>
    dispatch({ type: 'view.changed', view }),
  );
  const { picker, setPicker, form, setForm } = navigation;
  const draft = form ? navigation.formDraft : composer.draft;
  const setDraft = form ? navigation.setFormDraft : setComposerDraft;
  const input = draft.text;
  const setInput = useCallback(
    (value: string | ((previous: string) => string)) => {
      setDraft((previous) => {
        const text = typeof value === 'function' ? value(previous.text) : value;
        return { text, cursor: text.length };
      });
    },
    [setDraft],
  );
  const [pickerDetailExtent, setPickerDetailExtent] = useState(0);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [approvalDetailOffset, setApprovalDetailOffset] = useState(0);
  const [approvalDetailExtent, setApprovalDetailExtent] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState('');
  const [runtimeStatus, setRuntimeStatus] = useState<TuiRuntimeSummary | null>(null);
  const [preferences, setPreferences] = useState(defaultTuiPreferences);
  const sentHistory = composer.history;
  const historyIndex = useRef(-1);
  const historyDraft = useRef('');
  const selectedThreadRef = useRef<string | null>(composer.selection.threadId);
  const hydrationGeneration = useRef(0);
  const eventFence = useRef({ generation: -1, floor: 0, seen: new Set<number>() });
  const subscribeRef = useRef<
    (sessionId: string, after: number, generation: number, nextPage?: boolean) => void
  >(() => {});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      hydrationGeneration.current += 1;
    };
  }, []);
  const [historyOffset, setHistoryOffset] = useState(0);
  useEffect(() => {
    if (thread?.id) setHistoryOffset(0);
    setSearchFocus(undefined);
    searchResults.current = null;
  }, [thread?.id]);
  const [status, setStatus] = useState('Connecting…');
  useEffect(() => {
    void loadTuiPreferences(root)
      .then(setPreferences)
      .catch((cause: unknown) =>
        setError(`TUI preferences: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
  }, [root]);

  const loadPolicy = useCallback(
    async (sessionId: string) => {
      const sequence = ++policySequence.current;
      const policy = await request<{
        mode: string;
        grants: Array<{ tool: string; target: string }>;
      }>(baseUrl, token, `/api/sessions/${encodeURIComponent(sessionId)}/permissions`);
      if (sequence === policySequence.current && selectedSessionRef.current === sessionId)
        setSessionPolicy({ ...policy, sessionId });
      return policy;
    },
    [baseUrl, token],
  );
  useEffect(() => {
    setSessionPolicy(null);
    if (tuiState.selectedSessionId)
      void loadPolicy(tuiState.selectedSessionId).catch(() => setSessionPolicy(null));
  }, [tuiState.selectedSessionId, loadPolicy]);

  const loadIdentity = useCallback(
    async (sessionId: string): Promise<SessionIdentityStatus | null> => {
      const sequence = ++identityReadSequence.current;
      try {
        const status = await request<SessionIdentityStatus>(
          baseUrl,
          token,
          `/api/sessions/${encodeURIComponent(sessionId)}/identity`,
        );
        if (
          status.sessionId !== sessionId ||
          !Array.isArray(status.sources) ||
          typeof status.revision !== 'number'
        )
          throw new Error('Daemon identity status is unavailable.');
        if (!mounted.current || selectedSessionRef.current !== sessionId) return null;
        if (sequence === identityReadSequence.current) {
          setSessionIdentity(status);
          setIdentityError(null);
        }
        // A concurrent stream-triggered read may own rendering; this response is
        // still valid readback evidence for its caller in the same session.
        return status;
      } catch (cause) {
        if (
          mounted.current &&
          sequence === identityReadSequence.current &&
          selectedSessionRef.current === sessionId
        )
          setIdentityError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
    [baseUrl, token],
  );
  useEffect(() => {
    setSessionIdentity(null);
    setIdentityError(null);
    if (tuiState.selectedSessionId) void loadIdentity(tuiState.selectedSessionId);
  }, [tuiState.selectedSessionId, loadIdentity]);

  const hydrate = useCallback(
    async (
      session: Session,
      available: Thread[],
      allSessions: Session[],
      generation: number,
    ): Promise<void> => {
      const current = () => mounted.current && hydrationGeneration.current === generation;
      const nextThread =
        available.find((entry) => entry.id === selectedThreadRef.current) ?? available[0] ?? null;
      // Capture the cursor BEFORE presentation: anything changing either projection
      // after this boundary is replayed, even if the HTTP view already includes it.
      const snapshot = nextThread
        ? await request<RunSnapshot>(baseUrl, token, `/api/threads/${nextThread.id}/run-state`)
        : { activeRunId: null };
      if (!current()) return;
      const loaded = nextThread
        ? await loadConversationPage(baseUrl, token, nextThread.id)
        : { messages: [], nextCursor: 0, hasMore: false };
      if (!current()) return;
      activateComposer(session.id, nextThread?.id ?? null, carryDraft.current);
      carryDraft.current = false;
      selectedSessionRef.current = session.id;
      selectedThreadRef.current = nextThread?.id ?? null;
      setThread(nextThread);
      const preserveHistory =
        historyPage.current.threadId === nextThread?.id && historyPage.current.nextCursor > 0;
      if (!preserveHistory)
        historyPage.current = {
          threadId: nextThread?.id ?? null,
          nextCursor: loaded.nextCursor,
          hasMore: loaded.hasMore,
        };
      setMessages((previous) =>
        preserveHistory ? mergeTuiMessages(previous, loaded.messages) : loaded.messages,
      );
      setApprovalIndex(0);
      setApprovalDetailOffset(0);
      dispatch({
        type: 'sessions.loaded',
        sessions: allSessions,
        threads: available.map((value) => ({ ...value, sessionId: session.id })),
      });
      dispatch({ type: 'session.selected', sessionId: session.id });
      if (nextThread) dispatch({ type: 'thread.selected', threadId: nextThread.id });
      eventFence.current = { generation, floor: snapshot.lastEventId ?? 0, seen: new Set() };
      dispatch({
        type: 'run.hydrated',
        activeRunId: snapshot.activeRunId,
        events: (snapshot.events ?? [])
          .filter((event) => event.runId === snapshot.activeRunId)
          .flatMap((event) => {
            const value = toTuiEvent(event);
            return value ? [value] : [];
          }),
      });
      subscribeRef.current(session.id, snapshot.lastEventId ?? 0, generation);
      setStatus(`Connected · ${session.title}`);
      dispatch({ type: 'connection.changed', status: 'connected' });
      setError(null);
    },
    [baseUrl, token, activateComposer],
  );

  const refreshFlight = useRef<{
    generation: number;
    promise: Promise<{ ok: boolean; error?: string }>;
  } | null>(null);
  const refresh = useCallback((): Promise<{ ok: boolean; error?: string }> => {
    if (refreshFlight.current?.generation === hydrationGeneration.current)
      return refreshFlight.current.promise;
    const generation = ++hydrationGeneration.current;
    const promise = (async (): Promise<{ ok: boolean; error?: string }> => {
      const current = () => mounted.current && generation === hydrationGeneration.current;
      try {
        const result = await request<{ sessions: Session[] }>(baseUrl, token, '/api/sessions');
        if (!current()) return { ok: false, error: 'Conversation changed during refresh.' };
        let session =
          result.sessions.find((entry) => entry.id === selectedSessionRef.current) ??
          result.sessions.find((entry) => entry.sourceKey === `tui:${resolve(workspaceRoot)}`) ??
          (workspaceRoot === root ? result.sessions[0] : undefined);
        let available: Thread[];
        if (!session) {
          const created = await request<{ session: Session; thread: Thread }>(
            baseUrl,
            token,
            '/api/sessions/resolve',
            {
              method: 'POST',
              body: JSON.stringify({
                title: 'Main session',
                sourceKey: workspaceRoot === root ? 'tui:main' : `tui:${resolve(workspaceRoot)}`,
                workspaceRoot,
              }),
            },
          );
          if (!current()) return { ok: false, error: 'Conversation changed during refresh.' };
          session = created.session;
          result.sessions = [session];
          available = [created.thread];
        } else {
          const detail = await request<{ threads: Thread[] }>(
            baseUrl,
            token,
            `/api/sessions/${session.id}`,
          );
          if (!current()) return { ok: false, error: 'Conversation changed during refresh.' };
          available = detail.threads;
        }
        await hydrate(session, available, result.sessions, generation);
        if (!current()) return { ok: false, error: 'Conversation changed during refresh.' };
        // Management resources hydrate independently; they never hold the
        // conversation's single-flight lock or a successful submission busy.
        void loadCatalog(baseUrl, token, false);
        return { ok: true };
      } catch (cause) {
        if (!current()) return { ok: false, error: 'Conversation changed during refresh.' };
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        setStatus('Disconnected');
        dispatch({ type: 'connection.changed', status: 'disconnected', error: message });
        return { ok: false, error: message };
      }
    })().finally(() => {
      if (refreshFlight.current?.generation === generation) refreshFlight.current = null;
    });
    refreshFlight.current = { generation, promise };
    return promise;
  }, [baseUrl, token, hydrate, loadCatalog, workspaceRoot, root]);

  const selectSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const generation = ++hydrationGeneration.current;
      selectedSessionRef.current = sessionId;
      selectedThreadRef.current = null;
      setThread(null);
      setMessages([]);
      historyPage.current = { threadId: null, nextCursor: 0, hasMore: false };
      dispatch({ type: 'run.hydrated', activeRunId: null, events: [] });
      setStatus('Loading conversation…');
      try {
        const detail = await request<{ threads: Thread[] }>(
          baseUrl,
          token,
          `/api/sessions/${sessionId}`,
        );
        if (generation !== hydrationGeneration.current || !mounted.current) return;
        const session = sessions.find((entry) => entry.id === sessionId);
        if (session) await hydrate(session, detail.threads, sessions, generation);
      } catch (cause) {
        if (generation === hydrationGeneration.current && mounted.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [baseUrl, sessions, token, hydrate],
  );

  const selectThread = useCallback(
    async (threadId: string): Promise<void> => {
      const selected = threads.find((entry) => entry.id === threadId);
      const session = sessions.find((entry) => entry.id === selected?.sessionId);
      if (!selected || !session) return;
      const generation = ++hydrationGeneration.current;
      selectedThreadRef.current = threadId;
      setThread(null);
      setMessages([]);
      historyPage.current = { threadId: null, nextCursor: 0, hasMore: false };
      dispatch({ type: 'run.hydrated', activeRunId: null, events: [] });
      setStatus('Loading conversation…');
      try {
        await hydrate(session, threads, sessions, generation);
      } catch (cause) {
        if (generation === hydrationGeneration.current && mounted.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [threads, sessions, hydrate],
  );

  const loadOlder = async (): Promise<void> => {
    const page = historyPage.current;
    const generation = hydrationGeneration.current;
    if (
      !page.threadId ||
      page.threadId !== selectedThreadRef.current ||
      !page.hasMore ||
      olderFlight.current === generation
    )
      return;
    olderFlight.current = generation;
    try {
      const older = await loadConversationPage(baseUrl, token, page.threadId, page.nextCursor);
      if (
        !mounted.current ||
        generation !== hydrationGeneration.current ||
        page !== historyPage.current
      )
        return;
      historyPage.current = {
        ...page,
        nextCursor: older.nextCursor,
        hasMore: older.hasMore && older.nextCursor > 0 && older.nextCursor < page.nextCursor,
      };
      // The viewport is end-anchored. Prepending while keeping the offset
      // unchanged preserves the same visible rows; don't add the page height.
      setMessages((current) => mergeTuiMessages(older.messages, current));
    } catch (cause) {
      if (mounted.current && generation === hydrationGeneration.current)
        setError(`Older history: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (olderFlight.current === generation) olderFlight.current = null;
    }
  };

  const loadEntireConversation = async (): Promise<TuiConversationMessage[]> => {
    const threadId = selectedThreadRef.current;
    const generation = hydrationGeneration.current;
    if (!threadId) throw new Error('Select a conversation first.');
    const latest = await loadConversationPage(baseUrl, token, threadId);
    if (generation !== hydrationGeneration.current || threadId !== selectedThreadRef.current)
      throw new Error('Conversation changed; retry in the selected conversation.');
    let all = mergeTuiMessages(messages, latest.messages);
    let page =
      historyPage.current.threadId === threadId && historyPage.current.nextCursor > 0
        ? historyPage.current
        : { threadId, ...latest };
    while (page.hasMore) {
      const older = await loadConversationPage(baseUrl, token, threadId, page.nextCursor);
      if (generation !== hydrationGeneration.current || threadId !== selectedThreadRef.current)
        throw new Error('Conversation changed; retry in the selected conversation.');
      if (older.hasMore && (older.nextCursor <= 0 || older.nextCursor >= page.nextCursor))
        throw new Error('History pagination did not advance.');
      all = mergeTuiMessages(older.messages, all);
      page = { threadId, ...older };
    }
    historyPage.current = page;
    setMessages(all);
    return all;
  };
  const focusSearchResult = (position: number): void => {
    const result = searchResults.current;
    if (!result || result.threadId !== selectedThreadRef.current || !result.indices.length)
      throw new Error('Search this conversation first with /search.');
    result.position = (position + result.indices.length) % result.indices.length;
    setSearchFocus((previous) => ({
      index: result.indices[result.position],
      revision: (previous?.revision ?? 0) + 1,
    }));
    navigation.close();
    dispatch({ type: 'view.changed', view: 'conversation' });
    setNotice(
      `Match ${result.position + 1}/${result.indices.length} · Alt-J next · Alt-V previous`,
    );
  };

  const chatApprovals = tuiState.approvals.filter(
    (approval) => approval.threadId === thread?.id && approval.status === 'pending',
  );
  const selectedApproval =
    chatApprovals[Math.min(approvalIndex, Math.max(0, chatApprovals.length - 1))];

  const providerChoices = tuiState.providers.filter((provider) => provider.available);
  const providerName = tuiState.provider?.name ?? providerChoices[0]?.name ?? null;
  const provider = tuiState.providers.find((entry) => entry.name === providerName);
  const modelName =
    (providerName === tuiState.provider?.name ? tuiState.provider.model : null) ??
    provider?.models?.[0] ??
    null;

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let streamAbort: AbortController | null = null;
    let streamConnected = false;
    let lastStreamId = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let approvalFallbackTimer: ReturnType<typeof setInterval> | null = null;
    let retry = 0;

    const pendingReplays: Array<{ generation: number; sessionId: string; after: number }> = [];
    let subscribedGeneration = -1;
    subscribeRef.current = (sessionId, after, generation, nextPage = false) => {
      if (stopped) return;
      if (streamConnected) {
        if (!nextPage && subscribedGeneration === generation) return;
        subscribedGeneration = generation;
        void (async () => {
          let cursor = after;
          while (!stopped && hydrationGeneration.current === generation) {
            const response = await fetch(
              `${baseUrl}/api/events?sessionId=${encodeURIComponent(sessionId)}&after=${cursor}&limit=250`,
              { headers: { authorization: `Bearer ${token}` }, signal: streamAbort?.signal },
            );
            if (!response.ok) throw new Error(`Event replay HTTP ${response.status}`);
            const page = (await response.json()) as {
              events: DaemonEvent[];
              nextCursor: number;
              hasMore: boolean;
            };
            if (hydrationGeneration.current !== generation) return;
            for (const event of page.events)
              handleMessage({ data: JSON.stringify({ type: 'event', event }) });
            if (!page.hasMore || page.nextCursor <= cursor) return;
            cursor = page.nextCursor;
          }
        })().catch((cause) => {
          if (!stopped && !streamAbort?.signal.aborted)
            setError(cause instanceof Error ? cause.message : String(cause));
        });
        return;
      }
      if (socket?.readyState !== WebSocket.OPEN) return;
      if (!nextPage && subscribedGeneration === generation) return;
      subscribedGeneration = generation;
      pendingReplays.push({ generation, sessionId, after });
      socket.send(JSON.stringify({ type: 'subscribe', sessionId, after, limit: 250 }));
    };
    const handleMessage = (event: { data: unknown }) => {
      let value: { type: string; event?: DaemonEvent; nextCursor?: number; hasMore?: boolean };
      try {
        value = JSON.parse(String(event.data)) as typeof value;
      } catch {
        return;
      }
      if (value.type === 'replay.complete') {
        const page = pendingReplays.shift();
        if (!page || page.generation !== hydrationGeneration.current) return;
        if (value.hasMore && typeof value.nextCursor === 'number' && value.nextCursor > page.after)
          subscribeRef.current(page.sessionId, value.nextCursor, page.generation, true);
        return;
      }
      if (value.type === 'approvals.invalidated') {
        void loadCatalog(baseUrl, token);
        void refresh();
        return;
      }
      if (value.type !== 'event' || !value.event) return;
      const entry = value.event;
      const fence = eventFence.current;
      if (fence.generation !== hydrationGeneration.current) return;
      if (entry.sessionId && entry.sessionId !== selectedSessionRef.current) return;
      if (entry.threadId && entry.threadId !== selectedThreadRef.current) return;
      if (typeof entry.id === 'number') {
        if (entry.id <= fence.floor || fence.seen.has(entry.id)) return;
        fence.seen.add(entry.id);
      }
      const tuiEvent = toTuiEvent(entry);
      if (tuiEvent) dispatch(tuiEvent);
      if (
        entry.type === 'session.identity.changed' &&
        entry.sessionId === selectedSessionRef.current
      )
        void loadIdentity(entry.sessionId);
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(entry.type)) {
        // Replay can deliver a terminal event before its hydration refresh has
        // released the lock. Queue a fresh projection instead of swallowing it.
        const inFlight = refreshFlight.current;
        void refresh().then(() => {
          if (!stopped && inFlight && inFlight.generation === hydrationGeneration.current)
            void refresh();
        });
      } else if (entry.type.startsWith('approval.')) {
        if (selectedSessionRef.current)
          void loadPolicy(selectedSessionRef.current).catch(() => setSessionPolicy(null));
        void refresh();
      }
    };

    const connectLegacy = (): void => {
      if (stopped) return;
      const current = new WebSocket(
        `${baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`,
      );
      socket = current;
      subscribedGeneration = -1;
      pendingReplays.length = 0;
      current.onopen = () => {
        if (stopped || socket !== current) return;
        retry = 0;
        setStatus('Connected');
        dispatch({ type: 'connection.changed', status: 'connected' });
        void refresh().then(() => {
          if (stopped || socket !== current || !selectedSessionRef.current) return;
          const fence = eventFence.current;
          if (fence.generation === hydrationGeneration.current)
            subscribeRef.current(selectedSessionRef.current, fence.floor, fence.generation);
        });
      };
      current.onmessage = handleMessage;
      current.onerror = () => current.close();
      current.onclose = (event) => {
        if (stopped || socket !== current) return;
        const disposition = webSocketCloseDisposition(event.code, event.reason.toString());
        const message = disposition.message ?? 'WebSocket disconnected';
        setStatus(disposition.reconnect ? 'Reconnecting…' : 'Disconnected');
        dispatch({ type: 'connection.changed', status: 'disconnected', error: message });
        if (!disposition.reconnect) {
          stopped = true;
          setError(message);
          if (approvalFallbackTimer) clearInterval(approvalFallbackTimer);
          return;
        }
        retry += 1;
        reconnectTimer = setTimeout(connect, tuiReconnectDelayMs(retry));
      };
    };

    const connect = (): void => {
      if (stopped) return;
      const controller = new AbortController();
      streamAbort = controller;
      const headerDeadline = setTimeout(
        () => controller.abort(new Error('SSE connection timed out')),
        10_000,
      );
      void (async () => {
        try {
          const response = await fetch(`${baseUrl}/api/agent/stream`, {
            headers: {
              authorization: `Bearer ${token}`,
              Accept: 'text/event-stream',
              ...(lastStreamId ? { 'Last-Event-ID': String(lastStreamId) } : {}),
            },
            signal: controller.signal,
          });
          clearTimeout(headerDeadline);
          if (stopped || streamAbort !== controller) {
            await response.body?.cancel();
            return;
          }
          if (response.status === 401 || response.status === 403) {
            stopped = true;
            setStatus('Disconnected');
            setError('Session expired or access denied — pair this device again.');
            dispatch({ type: 'connection.changed', status: 'disconnected' });
            await response.body?.cancel();
            return;
          }
          if (
            response.status === 404 ||
            response.status === 405 ||
            (response.ok && !response.headers.get('content-type')?.includes('text/event-stream'))
          ) {
            await response.body?.cancel();
            connectLegacy();
            return;
          }
          if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
          streamConnected = true;
          subscribedGeneration = -1;
          retry = 0;
          setStatus('Connected');
          dispatch({ type: 'connection.changed', status: 'connected' });
          void refresh().then(() => {
            const fence = eventFence.current;
            if (
              !stopped &&
              selectedSessionRef.current &&
              fence.generation === hydrationGeneration.current
            )
              subscribeRef.current(selectedSessionRef.current, fence.floor, fence.generation);
          });
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            while (!stopped) {
              const frame = await reader.read();
              if (frame.done) break;
              buffer += decoder.decode(frame.value, { stream: true }).replace(/\r\n/g, '\n');
              let boundary = buffer.indexOf('\n\n');
              while (boundary >= 0) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const data = block
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trimStart())
                  .join('\n');
                if (data) {
                  const value = JSON.parse(data) as { event?: DaemonEvent };
                  if (value.event) {
                    if (typeof value.event.id === 'number')
                      lastStreamId = Math.max(lastStreamId, value.event.id);
                    if (value.event.type.startsWith('approval.'))
                      handleMessage({ data: JSON.stringify({ type: 'approvals.invalidated' }) });
                    handleMessage({ data: JSON.stringify({ type: 'event', event: value.event }) });
                  }
                }
                boundary = buffer.indexOf('\n\n');
              }
            }
          } finally {
            await reader.cancel();
          }
          if (!stopped) throw new Error('SSE disconnected');
        } catch (cause) {
          if (stopped || streamAbort !== controller) return;
          streamConnected = false;
          setStatus('Reconnecting…');
          dispatch({
            type: 'connection.changed',
            status: 'disconnected',
            error: cause instanceof Error ? cause.message : String(cause),
          });
          retry += 1;
          reconnectTimer = setTimeout(connect, tuiReconnectDelayMs(retry));
        } finally {
          clearTimeout(headerDeadline);
        }
      })();
    };

    void refresh();
    connect();
    approvalFallbackTimer = setInterval(() => {
      if (stopped || streamConnected || socket?.readyState === WebSocket.OPEN) return;
      void loadCatalog(baseUrl, token)
        .then((catalog) => {
          if (!stopped && !streamConnected && socket?.readyState !== WebSocket.OPEN)
            dispatch(catalog);
        })
        .catch((cause: unknown) => {
          if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
        });
    }, tuiApprovalFallbackIntervalMs);

    return () => {
      stopped = true;
      subscribeRef.current = () => {};
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (approvalFallbackTimer) clearInterval(approvalFallbackTimer);
      streamAbort?.abort();
      socket?.close();
    };
  }, [baseUrl, refresh, token, loadCatalog, loadIdentity, loadPolicy]);

  const openPicker = (title: string, items: PickerState['items'], detail?: string[]): void => {
    navigation.pushPicker({ title, items, query: '', index: 0, detail });
  };
  const runAction = (action: () => Promise<void>): void => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    void action()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };
  const showModels = (onlyProvider?: string): void => {
    openPicker(
      'Choose model',
      tuiState.providers
        .filter((entry) => !onlyProvider || entry.name === onlyProvider)
        .flatMap((entry) =>
          (entry.models ?? []).map((model) => ({
            id: `model:${JSON.stringify([entry.name, model])}`,
            label: `${entry.name} / ${model}${entry.name === providerName && model === modelName ? ' · current' : ''}`,
            detail: entry.detail,
            disabled: !entry.available,
          })),
        ),
      ['Selection is saved by the daemon. Escape keeps the current model.'],
    );
  };
  const loadLearning = async (): Promise<LearningStatus> => {
    const status = await request<LearningStatus>(baseUrl, token, '/api/memory/learning');
    learningRef.current = status;
    return status;
  };
  const settingsItems = (): PickerState['items'] => [
    { id: 'command:provider', label: `Provider · ${providerName ?? 'not selected'}` },
    { id: 'command:model', label: `Model · ${modelName ?? 'not selected'}` },
    {
      id: 'command:permissions',
      label: `Approval mode · ${sessionPolicy?.mode ?? 'unavailable'}`,
    },
    {
      id: 'setting:compact',
      label: `Transcript spacing · ${preferences.compact ? 'compact' : 'comfortable'}`,
      detail: 'Toggle and save terminal preference',
    },
    {
      id: 'setting:toolDetails',
      label: `Tool activity · ${preferences.toolDetails ? 'expanded' : 'compact'}`,
      detail: 'Toggle and save terminal preference',
    },
    { id: 'command:skills', label: 'Skills · enable / disable' },
    { id: 'command:plugins', label: 'Trusted plugins · enable / disable' },
    {
      id: 'setting:learning',
      label: `Agent learning · ${learningRef.current?.available ? learningRef.current.mode : 'inspect / change'}`,
    },
  ];
  const showSettings = (): void => openPicker('Settings', settingsItems());
  const managementIndex = (kind: 'memory' | 'schedules' | 'tasks'): PickerState =>
    kind === 'memory'
      ? managementList({ kind, values: catalogRef.current.memories })
      : kind === 'schedules'
        ? managementList({ kind, values: catalogRef.current.schedules })
        : managementList({ kind, values: catalogRef.current.tasks });
  const refreshMenu = (previous: PickerState): PickerState => {
    let fresh = previous;
    if (previous.title === 'Settings') fresh = { ...previous, items: settingsItems() };
    else if (previous.title === 'Agent learning') fresh = learningModeMenu(learningRef.current);
    else if (previous.title === 'Search memories') fresh = managementIndex('memory');
    else if (previous.title === 'Automations') fresh = managementIndex('schedules');
    else if (previous.title === 'Background tasks') fresh = managementIndex('tasks');
    else {
      const item = previous.items.find((entry) => entry.id.startsWith('manage:'));
      if (item) {
        const action = JSON.parse(item.id.slice(7)) as ManagementAction;
        if (action.resource === 'schedules') {
          const value = catalogRef.current.schedules.find((entry) => entry.id === action.id);
          if (value) fresh = managementMenu({ kind: 'schedules', value });
        } else if (action.resource === 'memory') {
          const value = catalogRef.current.memories.find((entry) => entry.id === action.id);
          if (value) fresh = managementMenu({ kind: 'memory', value });
        }
      }
    }
    const selected = pickerMatches(previous)[previous.index]?.id;
    const next = {
      ...fresh,
      query: previous.query,
      index: previous.index,
      detailOffset: previous.detailOffset,
    };
    const items = pickerMatches(next);
    const index = items.findIndex((item) => item.id === selected);
    return {
      ...next,
      index: index >= 0 ? index : Math.max(0, Math.min(next.index, items.length - 1)),
    };
  };
  const backMenu = () => navigation.back(refreshMenu);
  const toggleItems = (kind: 'skills' | 'plugins'): PickerState['items'] =>
    (kind === 'skills' ? catalogRef.current.skills : catalogRef.current.plugins).map((entry) => ({
      id: `${kind === 'skills' ? 'skill' : 'plugin'}:${JSON.stringify([kind, entry.name, entry.enabled === false ? 'enable' : 'disable'])}`,
      label: `${entry.name} · ${entry.enabled === false ? 'disabled' : 'enabled'}`,
      detail: 'description' in entry ? String(entry.description) : undefined,
    }));
  const showAttachmentPaths = async (path = ''): Promise<void> => {
    openPicker('Attach file', await attachmentPaths(path), [
      'Choose a directory or file · UTF-8 text/source and PNG/JPEG/WebP · 4 files, 512 KiB total',
    ]);
  };
  const chooseItem = async (id: string): Promise<void> => {
    if (id === 'setting:learning') {
      const menu = learningModeMenu(await loadLearning());
      openPicker(menu.title, menu.items, menu.detail);
      return;
    }
    if (id.startsWith('learning:')) {
      const mode = id.slice('learning:'.length) as LearningStatus['mode'];
      await request(baseUrl, token, '/api/memory/learning', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      const observed = await loadLearning();
      setPicker((current) => (current ? refreshMenu(current) : current));
      if (observed.mode !== mode)
        throw new Error('Learning readback mismatch; displaying the actual setting.');
      setNotice(`Agent learning · ${observed.mode}`);
      return;
    }
    if (id.startsWith('policy:')) {
      const [sessionId, mode, confirmed] = JSON.parse(id.slice(7)) as [string, string, boolean];
      if (selectedSessionRef.current !== sessionId)
        throw new Error('Conversation changed; reopen /permissions.');
      if (mode === 'unguarded' && !confirmed) {
        openPicker('Enable Unguarded mode?', [
          { id: 'policy-cancel', label: 'Keep current mode' },
          {
            id: `policy:${JSON.stringify([sessionId, mode, true])}`,
            label: 'Enable Unguarded for this session',
            detail:
              'No action approval prompts. Host CLI tools run with OS-account access beyond the workspace. Native file protections and permission profiles remain enforced. Saved for this conversation only.',
          },
        ]);
        return;
      }
      await request(baseUrl, token, `/api/sessions/${encodeURIComponent(sessionId)}/permissions`, {
        method: 'POST',
        body: JSON.stringify({
          mode: mode === 'reset' ? 'manual' : mode,
          confirmUnguarded: confirmed,
          revokeGrants: mode === 'reset',
        }),
      });
      const observed = await loadPolicy(sessionId);
      if (
        observed.mode !== (mode === 'reset' ? 'manual' : mode) ||
        (mode === 'reset' && observed.grants.length)
      )
        throw new Error('Approval policy readback mismatch.');
      if (picker?.title === 'Enable Unguarded mode?') backMenu();
      setPicker((current) =>
        current?.title === 'Approval mode'
          ? {
              ...approvalModeMenu(sessionId, observed),
              query: current.query,
              index: current.index,
            }
          : current,
      );
      setNotice(
        mode === 'reset'
          ? 'Session grants revoked · Approval mode · manual'
          : `Approval mode · ${observed.mode}`,
      );
      return;
    }
    if (id.startsWith('task-review:')) {
      const diagnostics = await request<NonNullable<ReturnType<Scheduler['inspectTask']>>>(
        baseUrl,
        token,
        `/api/tasks/${encodeURIComponent(id.slice(12))}`,
      );
      if (!diagnostics.execution) throw new Error('Child conversation linkage is unavailable.');
      await selectSession(diagnostics.execution.sessionId);
      await selectThread(diagnostics.execution.threadId);
      navigation.close();
      dispatch({ type: 'view.changed', view: 'conversation' });
      setNotice('Review the child action card; opening it does not approve it.');
      return;
    }
    if (id.startsWith('identity-source:')) return;
    if (id.startsWith('identity-refresh:')) {
      const sessionId = id.slice(17);
      if (sessionId !== selectedSessionRef.current)
        throw new Error('Conversation changed; review its identity before refreshing.');
      const changed = await request<SessionIdentityStatus>(
        baseUrl,
        token,
        `/api/sessions/${encodeURIComponent(sessionId)}/identity/refresh`,
        { method: 'POST', body: '{}' },
      );
      const observed = await loadIdentity(sessionId);
      if (!observed || observed.id !== changed.id)
        throw new Error('Identity refresh readback was not confirmed.');
      backMenu();
      setPicker((current) =>
        current ? { ...current, detail: identityStatusLines(observed) } : current,
      );
      setNotice(`Identity refreshed · revision ${observed.revision}`);
      return;
    }
    if (id.startsWith('attach-dir:')) {
      await showAttachmentPaths(id.slice(11));
      return;
    }
    if (id.startsWith('attach-file:')) {
      const threadId = selectedThreadRef.current;
      const attachment = await readAttachment(id.slice(12), composer.attachments);
      if (threadId !== selectedThreadRef.current)
        throw new Error('Conversation changed; attach again.');
      composer.setAttachments((current) => [...current, attachment]);
      if (!picker) navigation.close();
      if (input.startsWith('/attach'))
        setDraft((current) => (current.text === input ? { text: '', cursor: 0 } : current));
      setNotice(`Attached ${attachment.name}`);
      return;
    }
    if (id.startsWith('attachment-remove:')) {
      composer.setAttachments((current) =>
        current.filter((_, index) => index !== Number(id.slice(18))),
      );
      setPicker((current) =>
        current
          ? {
              ...current,
              items: composer.attachments
                .filter((_, index) => index !== Number(id.slice(18)))
                .map((attachment, index) => ({
                  id: `attachment-remove:${index}`,
                  label: `Remove ${attachment.name}`,
                  detail: `${Buffer.from(attachment.data, 'base64').length} bytes · Enter removes this attachment from the draft`,
                })),
            }
          : current,
      );
      setNotice('Attachment removed');
      return;
    }
    if (id.startsWith('output-')) {
      const context = outputContext.current;
      if (!context || context.threadId !== selectedThreadRef.current)
        throw new Error('Conversation changed; reopen /outputs.');
      const [kind, encoded] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
      if (kind === 'output-response') {
        const index = Number(encoded);
        const message = context.messages[index];
        openPicker('Response actions', [
          { id: `output-copy:${JSON.stringify([index, -1])}`, label: 'Copy response' },
          ...codeBlocks(message.content).map((block, blockIndex) => ({
            id: `output-copy:${JSON.stringify([index, blockIndex])}`,
            label: `Copy code block ${blockIndex + 1}`,
            detail: block,
          })),
        ]);
        return;
      }
      const [index, part] = JSON.parse(encoded) as [number, number];
      const message = context.messages[index];
      if (kind === 'output-copy') {
        const text = part < 0 ? message.content : codeBlocks(message.content)[part];
        if (text === undefined) throw new Error('Code block no longer exists.');
        stdout.write(clipboardSequence(text));
        setNotice('Clipboard request sent · OSC52 requires terminal permission/support');
        return;
      }
      const artifact = message.artifacts?.[part];
      if (!artifact || artifact.type !== 'artifact') throw new Error('Artifact no longer exists.');
      if (kind === 'output-artifact') {
        openPicker('Artifact actions', [
          ...(artifact.downloadUrl
            ? [
                {
                  id: `output-save:${encoded}`,
                  label: 'Save artifact',
                  detail: 'Save a new private file; never overwrite',
                },
              ]
            : []),
          {
            id: `output-open:${encoded}`,
            label: 'Open artifact',
            detail: 'Open with the system viewer/browser; executable file types are refused',
          },
        ]);
        return;
      }
      if (kind === 'output-save' || kind === 'output-open') {
        if (artifact.downloadUrl) {
          const path = await saveArtifact(
            baseUrl,
            token,
            artifact.downloadUrl,
            artifact.title,
            root,
          );
          setNotice(`Artifact saved: ${relative(root, path)}`);
          if (kind === 'output-open') {
            await openOutput(path);
            setNotice(`Open requested: ${path}`);
          }
        } else if (kind === 'output-open' && artifact.externalUrl) {
          await openOutput(artifact.externalUrl);
          setNotice('Open requested in the system browser');
        } else throw new Error('This artifact has no downloadable file.');
        return;
      }
    }
    if (id.startsWith('key-help:')) return;
    if (id.startsWith('search:')) {
      const index = Number(id.slice(7));
      const hits = pickerMatches(picker ?? { title: '', query: '', index: 0, items: [] });
      searchResults.current = {
        threadId: selectedThreadRef.current ?? '',
        indices: hits.map((item) => Number(item.id.slice(7))),
        position: 0,
      };
      focusSearchResult(searchResults.current.indices.indexOf(index));
      return;
    }
    if (id.startsWith('save-schedule:')) {
      const draft = JSON.parse(id.slice(14)) as TuiScheduleDraft;
      await request(
        baseUrl,
        token,
        draft.id ? `/api/schedules/${encodeURIComponent(draft.id)}` : '/api/schedules',
        { method: draft.id ? 'PUT' : 'POST', body: JSON.stringify(draft) },
      );
      const catalog = await loadCatalog(baseUrl, token, true, '/api/schedules');
      const saved = catalog.schedules.find((entry) =>
        draft.id
          ? entry.id === draft.id
          : entry.name === draft.name && entry.agentInput === draft.agentInput,
      );
      if (
        !saved ||
        saved.type !== draft.type ||
        saved.expression !== draft.expression ||
        saved.enabled !== draft.enabled
      )
        throw new Error(
          'The daemon did not confirm the saved automation. Refresh before retrying.',
        );
      const parent = backMenu();
      if (parent?.form) setForm({ ...parent.form, original: { ...draft, id: saved.id } });
      setNotice('Automation saved and verified');
      return;
    }
    if (id.startsWith('inspect:')) {
      const [kind, resourceId] = JSON.parse(id.slice(8)) as [string, string];
      if (kind === 'memory') {
        const value = tuiState.memories.find((entry) => entry.id === resourceId);
        if (!value) throw new Error('Memory no longer exists. Use /refresh.');
        navigation.pushPicker(managementMenu({ kind, value }));
      } else if (kind === 'schedules') {
        const value = tuiState.schedules.find((entry) => entry.id === resourceId);
        if (!value) throw new Error('Schedule no longer exists. Use /refresh.');
        navigation.pushPicker(managementMenu({ kind, value }));
      } else if (kind === 'tasks') {
        const value = tuiState.tasks.find((entry) => entry.id === resourceId);
        if (!value) throw new Error('Task no longer exists. Use /refresh.');
        const diagnostics = await request<NonNullable<ReturnType<Scheduler['inspectTask']>>>(
          baseUrl,
          token,
          `/api/tasks/${encodeURIComponent(resourceId)}`,
        );
        const menu = managementMenu({ kind, value: { ...value, status: diagnostics.task.status } });
        if (diagnostics.execution)
          menu.items.unshift({
            id: `task-review:${resourceId}`,
            label: 'Review child conversation',
            detail: 'Open the linked run and any pending approval; does not grant permission.',
          });
        menu.detail = [
          ...(diagnostics.pause
            ? [
                `Paused: ${diagnostics.pause.reason}`,
                ...(diagnostics.pause.approval
                  ? [
                      `Pending approval: ${diagnostics.pause.approval.toolName} · ${diagnostics.pause.approval.id}`,
                    ]
                  : []),
              ]
            : []),
          ...(menu.detail ?? []),
          ...(diagnostics.failure
            ? [
                `Cause: ${diagnostics.failure.message}`,
                `Failure event: ${diagnostics.failure.eventId ?? 'not recorded'}`,
              ]
            : []),
          `Linkage: ${diagnostics.linkage}`,
          ...(diagnostics.execution
            ? [
                `Run: ${diagnostics.execution.runId}`,
                `Correlation: ${diagnostics.execution.correlationId}`,
              ]
            : []),
        ];
        navigation.pushPicker(menu);
      }
      return;
    }
    if (id.startsWith('manage:') || id.startsWith('confirmed:')) {
      const action = JSON.parse(id.slice(id.indexOf(':') + 1)) as ManagementAction;
      if (action.action === 'edit') {
        const schedule = tuiState.schedules.find((entry) => entry.id === action.id);
        if (!schedule) throw new Error('Schedule no longer exists.');
        const draft = {
          id: schedule.id,
          name: schedule.name,
          type: schedule.type as TuiScheduleDraft['type'],
          expression: schedule.expression ?? '',
          agentInput: schedule.agentInput ?? '',
          enabled: schedule.enabled,
        };
        const next = scheduleForm(draft);
        navigation.pushForm(next);
        setNotice('');
        return;
      }
      if (id.startsWith('manage:') && ['delete', 'trigger', 'cancel'].includes(action.action)) {
        navigation.pushPicker(confirmationMenu(action));
        return;
      }
      const operation = managementRequest(action);
      await request(baseUrl, token, operation.path, { method: operation.method });
      if (action.action !== 'trigger') {
        let entry:
          | { id: string; enabled?: boolean; status?: string; metadata?: Record<string, unknown> }
          | undefined;
        if (
          action.resource === 'memory' ||
          action.resource === 'schedules' ||
          action.resource === 'tasks'
        ) {
          const catalog = await loadCatalog(baseUrl, token, true, `/api/${action.resource}`);
          const values =
            action.resource === 'memory'
              ? catalog.memories
              : action.resource === 'schedules'
                ? catalog.schedules
                : catalog.tasks;
          entry = values.find((value) => value.id === action.id);
        } else {
          const path =
            action.resource === 'threads'
              ? `/api/sessions/${selectedSessionRef.current}`
              : '/api/sessions';
          const snapshot = await request<Record<string, Array<{ id: string }>>>(
            baseUrl,
            token,
            path,
          );
          entry = snapshot[action.resource]?.find((value) => value.id === action.id);
        }
        if (
          action.action === 'delete'
            ? Boolean(entry)
            : !entry ||
              (action.action === 'pause' && entry.enabled !== false) ||
              (action.action === 'resume' && entry.enabled !== true) ||
              (action.action === 'cancel' && entry.status !== 'cancelled') ||
              (action.action === 'revert' &&
                (entry.metadata?.knowledge as Record<string, unknown> | undefined)?.state !==
                  'disabled')
        )
          throw new Error(
            'The daemon did not confirm the requested change. Refresh before retrying.',
          );
      }
      if (action.action === 'delete' && action.resource === 'sessions') {
        selectedSessionRef.current = null;
        selectedThreadRef.current = null;
        setThread(null);
        setMessages([]);
      }
      if (action.action === 'delete' && action.resource === 'threads') {
        selectedThreadRef.current = null;
        setThread(null);
        setMessages([]);
      }
      await refresh();
      if (action.action === 'delete') {
        if (action.resource === 'sessions' || action.resource === 'threads') navigation.close();
        else {
          backMenu();
          backMenu();
        }
      } else if (id.startsWith('confirmed:')) backMenu();
      else setPicker((current) => (current ? refreshMenu(current) : current));
      setNotice(
        action.action === 'delete'
          ? 'Deletion verified'
          : action.action === 'trigger'
            ? 'Schedule run requested'
            : action.action === 'revert'
              ? 'Learning undo verified'
              : action.action === 'cancel'
                ? 'Task cancellation verified'
                : `Schedule ${action.action === 'pause' ? 'paused' : 'resumed'}`,
      );
      return;
    }
    if (id.startsWith('command:')) {
      await executeCommand(`/${id.slice(8)}`, true);
      return;
    }
    if (id.startsWith('provider:')) {
      showModels(id.slice(9));
      return;
    }
    if (id.startsWith('model:')) {
      const [provider, model] = JSON.parse(id.slice(6)) as [string, string];
      const selected = await request<{ active: { name: string; model: string } }>(
        baseUrl,
        token,
        '/api/providers/switch',
        {
          method: 'POST',
          body: JSON.stringify({ provider, model }),
        },
      );
      const catalog = await loadCatalog(baseUrl, token, true, '/api/providers');
      if (catalog.active?.name !== provider || catalog.active.model !== model)
        throw new Error('The daemon did not confirm the selected model. Refresh before retrying.');
      setPicker((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) => ({
                ...item,
                label:
                  item.label.replace(/ · current$/u, '') + (item.id === id ? ' · current' : ''),
              })),
            }
          : current,
      );
      setNotice(`Model saved · ${selected.active.name} / ${selected.active.model}`);
      return;
    }
    if (id.startsWith('session:')) {
      await selectSession(id.slice(8));
      navigation.close();
      dispatch({ type: 'view.changed', view: 'conversation' });
      return;
    }
    if (id.startsWith('thread:')) {
      await selectThread(id.slice(7));
      navigation.close();
      dispatch({ type: 'view.changed', view: 'conversation' });
      return;
    }
    if (id.startsWith('setting:')) {
      const key = id.slice(8) as 'compact' | 'toolDetails';
      const next = { ...preferences, [key]: !preferences[key] };
      await saveTuiPreferences(root, next);
      setPreferences(next);
      setPicker((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === id
                  ? {
                      ...item,
                      label:
                        key === 'compact'
                          ? `Transcript spacing · ${next.compact ? 'compact' : 'comfortable'}`
                          : `Tool activity · ${next.toolDetails ? 'expanded' : 'compact'}`,
                    }
                  : item,
              ),
            }
          : current,
      );
      setNotice('Terminal preference saved');
      return;
    }
    if (id.startsWith('skill:') || id.startsWith('plugin:')) {
      const [kind, name, action] = JSON.parse(id.slice(id.indexOf(':') + 1)) as [
        string,
        string,
        string,
      ];
      await request(baseUrl, token, `/api/${kind}/${encodeURIComponent(name)}/${action}`, {
        method: 'POST',
      });
      const catalog = await loadCatalog(baseUrl, token, true, `/api/${kind}`);
      const entries = kind === 'skills' ? catalog.skills : catalog.plugins;
      const observed = entries.find((entry) => entry.name === name);
      if (!observed || (observed.enabled !== false) !== (action === 'enable'))
        throw new Error('The daemon did not confirm the saved state. Refresh before retrying.');
      setPicker((current) =>
        current
          ? { ...current, items: toggleItems(kind === 'skills' ? 'skills' : 'plugins') }
          : current,
      );
      setNotice(`${name}: ${action} applied`);
      return;
    }
    if (id.startsWith('decision:')) {
      const [approval, payloadHash, action, scope] = JSON.parse(id.slice(9)) as [
        string,
        string,
        string,
        string?,
      ];
      await request(baseUrl, token, `/api/approvals/${encodeURIComponent(approval)}/${action}`, {
        method: 'POST',
        body: JSON.stringify(
          action === 'approve' ? { payloadHash, scope: scope ?? 'once' } : { payloadHash },
        ),
      });
      void loadCatalog(baseUrl, token);
      navigation.close();
      setNotice(`Action ${action === 'approve' ? 'approved' : 'denied'}`);
      return;
    }
    if (id.startsWith('resume:')) {
      await request(baseUrl, token, `/api/runs/${encodeURIComponent(id.slice(7))}/resume`, {
        method: 'POST',
      });
      navigation.close();
      setNotice('Run resume requested');
      return;
    }
    backMenu();
  };
  const executeParsedCommand = async (
    { command, argument }: NonNullable<ReturnType<typeof parseCommand>>,
    preserveDraft: boolean,
  ): Promise<void> => {
    setCommandIndex(0);
    setNotice('');
    if (command === 'quit' || command === 'exit') {
      exit();
      return;
    }
    if (command === 'model' || command === 'models') {
      if (!argument) {
        showModels();
        return;
      }
      const candidates = tuiState.providers
        .filter((entry) => entry.available)
        .flatMap((entry) =>
          (entry.models ?? [])
            .filter((model) => model === argument)
            .map((model) => [entry.name, model]),
        );
      const selected =
        candidates.find(([name]) => name === providerName) ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (!selected)
        throw new Error(
          'Model not found or ambiguous. Use /model to choose from the live catalog.',
        );
      await chooseItem(`model:${JSON.stringify(selected)}`);
      return;
    }
    if (command === 'provider' || command === 'providers') {
      if (argument) {
        if (!tuiState.providers.some((entry) => entry.name === argument && entry.available))
          throw new Error(`Provider unavailable: ${argument}`);
        showModels(argument);
        return;
      }
      openPicker(
        'Choose provider',
        tuiState.providers.map((entry) => ({
          id: `provider:${entry.name}`,
          label: entry.name,
          detail: entry.detail,
          disabled: !entry.available,
        })),
      );
      return;
    }
    if (command === 'delete' || command === 'delete-thread') {
      const resource = command === 'delete' ? 'sessions' : 'threads';
      const id = command === 'delete' ? selectedSessionRef.current : selectedThreadRef.current;
      if (!id) throw new Error('Nothing selected to delete.');
      navigation.pushPicker(confirmationMenu({ resource, id, action: 'delete' }));
      return;
    }
    if (command === 'identity' || command === 'identity-refresh') {
      const sessionId = selectedSessionRef.current;
      if (!sessionId) throw new Error('Select a session first.');
      const status = await loadIdentity(sessionId);
      if (!status) throw new Error('Identity status unavailable; no instructions were changed.');
      if (command === 'identity-refresh' || argument === 'refresh')
        openPicker(
          'Refresh session identity?',
          [
            { id: 'close', label: 'Back · keep the current snapshot' },
            {
              id: `identity-refresh:${sessionId}`,
              label: 'Reload instruction files',
              detail:
                'Future runs use a new snapshot. Already admitted runs retain their pinned identity.',
            },
          ],
          identityStatusLines(status),
        );
      else
        openPicker(
          'Session identity',
          [
            ...status.sources.map((source, index) => ({
              id: `identity-source:${index}`,
              label: `${source.scope}/${source.name} · ${source.status}`,
              detail: `${source.bytesRead} bytes read${source.errorCode ? ` · ${source.errorCode}` : ''}`,
              disabled: true,
            })),
            {
              id: 'command:identity-refresh',
              label: 'Refresh identity sources',
              detail: 'Explicitly reload the same permitted instruction roots for future runs',
            },
          ],
          identityStatusLines(status),
        );
      return;
    }
    if (command === 'status') {
      setRuntimeStatus(await request<TuiRuntimeSummary>(baseUrl, token, '/api/status'));
      navigation.close();
      setPanelOffset(0);
      dispatch({ type: 'view.changed', view: 'settings' });
      return;
    }
    if (command === 'export') {
      const all = await loadEntireConversation();
      const path = await exportConversation(
        root,
        thread?.title ?? 'Conversation',
        all,
        argument || undefined,
      );
      setPicker(null);
      setNotice(`Export saved: ${relative(root, path)}`);
      return;
    }
    if (command === 'outputs') {
      const all = await loadEntireConversation();
      outputContext.current = { threadId: selectedThreadRef.current ?? '', messages: all };
      openPicker(
        'Conversation outputs',
        all.flatMap((message, index) => [
          ...(message.role === 'assistant' && message.content
            ? [
                {
                  id: `output-response:${index}`,
                  label: `Response · ${message.content.replaceAll('\n', ' ').slice(0, 90)}`,
                },
              ]
            : []),
          ...(message.artifacts ?? []).flatMap((artifact, part) =>
            artifact.type === 'artifact'
              ? [
                  {
                    id: `output-artifact:${JSON.stringify([index, part])}`,
                    label: `Artifact · ${artifact.title}`,
                  },
                ]
              : [],
          ),
        ]),
      );
      return;
    }
    if (command === 'attach') {
      if (argument) await chooseItem(`attach-file:${argument}`);
      else await showAttachmentPaths();
      return;
    }
    if (command === 'attachments') {
      openPicker(
        'Pending attachments',
        composer.attachments.map((attachment, index) => ({
          id: `attachment-remove:${index}`,
          label: `Remove ${attachment.name}`,
          detail: `${Buffer.from(attachment.data, 'base64').length} bytes · Enter removes this attachment from the draft`,
        })),
      );
      return;
    }
    if (command === 'search') {
      const all = await loadEntireConversation();
      openPicker(
        'Search conversation',
        all.map((message, index) => ({
          id: `search:${index}`,
          label: `${message.role === 'user' ? 'You' : 'NUAAI'} · ${message.content.replaceAll('\n', ' ')}`,
          detail: message.content,
        })),
        ['Enter jumps to a matching turn · Alt-J next · Alt-V previous'],
      );
      if (argument) setPicker((current) => (current ? { ...current, query: argument } : current));
      return;
    }
    if (command === 'search-next' || command === 'search-prev') {
      focusSearchResult(
        (searchResults.current?.position ?? 0) + (command === 'search-next' ? 1 : -1),
      );
      return;
    }
    if (command === 'toggle-details' || command === 'toggle-compact') {
      await chooseItem(`setting:${command === 'toggle-details' ? 'toolDetails' : 'compact'}`);
      return;
    }
    if (command === 'help') {
      openPicker(
        'Commands and shortcuts',
        [
          ...tuiCommands.map((entry) => ({
            id: `command:${entry.command}`,
            label: `${entry.usage}${shortcutHint(entry.command) ? ` · ${shortcutHint(entry.command)}` : ''}`,
            detail: entry.description,
          })),
          ...tuiShortcuts
            .filter((entry) => entry.command.startsWith('toggle-'))
            .map((entry) => ({
              id: `command:${entry.command}`,
              label: entry.keys.join(' / '),
              detail: entry.description,
            })),
          ...tuiKeyHelp.map(([label, detail]) => ({ id: `key-help:${label}`, label, detail })),
        ],
        [
          'Type an action or key to filter · Enter runs commands; key references are read-only.',
          'Alt shortcuts also work as Escape then letter. Forms keep their own editing keys.',
        ],
      );
      return;
    }
    if (command === 'memory' || command === 'tasks' || command === 'schedules') {
      await loadCatalog(baseUrl, token, true, `/api/${command}`);
      navigation.pushPicker(managementIndex(command));
      return;
    }
    if (command === 'schedule-edit') {
      if (!argument) throw new Error('Use /schedules, select an automation, then Edit.');
      const draft = parseScheduleCommand(argument, 'edit');
      const current = tuiState.schedules.find((entry) => entry.id === draft.id);
      if (!current) throw new Error('Schedule no longer exists. Use /schedules.');
      await request(baseUrl, token, `/api/schedules/${encodeURIComponent(draft.id ?? '')}`, {
        method: 'PUT',
        body: JSON.stringify({ ...draft, enabled: current.enabled }),
      });
      await loadCatalog(baseUrl, token, true, '/api/schedules');
      setNotice('Schedule changes saved');
      return;
    }
    if (command === 'skill') {
      if (!argument) throw new Error('Use /skill <name> to read a skill.');
      const skill = await request<{ name: string; instructions: string }>(
        baseUrl,
        token,
        `/api/skills/${encodeURIComponent(argument)}`,
      );
      openPicker(`Skill · ${skill.name}`, [], skill.instructions.split('\n'));
      return;
    }
    if (command === 'skill-create') {
      const separator = argument.indexOf('|');
      if (separator < 1) throw new Error('Use /skill-create <name>|<instructions>.');
      const created = await request<{ name: string }>(baseUrl, token, '/api/skills', {
        method: 'POST',
        body: JSON.stringify({
          name: argument.slice(0, separator).trim(),
          instructions: argument.slice(separator + 1).trim(),
        }),
      });
      await loadCatalog(baseUrl, token, true, '/api/skills');
      setNotice(`Skill created · ${created.name}`);
      return;
    }
    if (command === 'permissions') {
      const sessionId = selectedSessionRef.current;
      if (!sessionId) throw new Error('Create a conversation first.');
      const policy = await loadPolicy(sessionId);
      if (selectedSessionRef.current !== sessionId)
        throw new Error('Conversation changed; retry /permissions.');
      if (argument) {
        if (!['manual', 'smart', 'unguarded', 'reset'].includes(argument))
          throw new Error('Use /permissions [manual|smart|unguarded|reset]');
        await chooseItem(`policy:${JSON.stringify([sessionId, argument, false])}`);
      } else navigation.pushPicker(approvalModeMenu(sessionId, policy));
      return;
    }
    if (command === 'settings') {
      showSettings();
      return;
    }
    if (command === 'sessions') {
      openPicker(
        'Conversations',
        sessions.map((entry) => ({
          id: `session:${entry.id}`,
          label: `${entry.title}${entry.id === tuiState.selectedSessionId ? ' · current' : ''}`,
          detail: entry.id,
        })),
      );
      return;
    }
    if (command === 'threads') {
      openPicker(
        'Threads',
        threads
          .filter((entry) => entry.sessionId === tuiState.selectedSessionId)
          .map((entry) => ({
            id: `thread:${entry.id}`,
            label: `${entry.title}${entry.id === thread?.id ? ' · current' : ''}`,
            detail: entry.id,
          })),
      );
      return;
    }
    if (command === 'new' || command === 'thread') {
      carryDraft.current = preserveDraft;
      if (command === 'new') {
        const previousSessionId = selectedSessionRef.current;
        const previousIdentity = previousSessionId
          ? sessionIdentity?.sessionId === previousSessionId
            ? sessionIdentity
            : await request<SessionIdentityStatus>(
                baseUrl,
                token,
                `/api/sessions/${encodeURIComponent(previousSessionId)}/identity`,
              )
          : null;
        if (selectedSessionRef.current !== previousSessionId)
          throw new Error('Conversation changed while resolving its workspace. Retry /new.');
        const created = await request<{ session: Session; thread: Thread }>(
          baseUrl,
          token,
          '/api/sessions',
          {
            method: 'POST',
            body: JSON.stringify({
              title: argument || 'New conversation',
              workspaceRoot: previousIdentity?.workspaceRoot ?? workspaceRoot,
              sourceKey: `tui:${randomUUID()}`,
            }),
          },
        );
        selectedSessionRef.current = created.session.id;
        selectedThreadRef.current = created.thread.id;
      } else {
        if (!selectedSessionRef.current) throw new Error('Create a conversation first with /new.');
        const created = await request<{ thread: Thread }>(
          baseUrl,
          token,
          `/api/sessions/${selectedSessionRef.current}/threads`,
          { method: 'POST', body: JSON.stringify({ title: argument || 'New thread' }) },
        );
        selectedThreadRef.current = created.thread.id;
      }
      await refresh();
      navigation.close();
      dispatch({ type: 'view.changed', view: 'conversation' });
      return;
    }
    if (command === 'rename' || command === 'rename-thread') {
      if (!argument) {
        setInput(`/${command} `);
        navigation.close();
        setNotice('Type the new title, then Enter.');
        return;
      }
      const id = command === 'rename' ? selectedSessionRef.current : thread?.id;
      if (!id) throw new Error('No conversation selected.');
      await request(baseUrl, token, `/api/${command === 'rename' ? 'sessions' : 'threads'}/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ title: argument }),
      });
      await refresh();
      setNotice('Title saved');
      navigation.close();
      return;
    }
    if (command === 'approvals' || command === 'approve' || command === 'deny') {
      const catalog = await loadCatalog(baseUrl, token, true, '/api/approvals?status=pending');
      navigation.close();
      setHistoryOffset(0);
      setApprovalIndex(0);
      dispatch({ type: 'view.changed', view: 'conversation' });
      setNotice(
        catalog.approvals?.some((approval) => approval.threadId === thread?.id)
          ? 'Review the inline action card · Ctrl-Y approve once · Ctrl-N deny'
          : 'No pending approvals in this conversation.',
      );
      return;
    }
    if (command === 'cancel' || command === 'stop') {
      if (!tuiState.activeRunId) {
        setNotice('No active run in this thread.');
        return;
      }
      await request(baseUrl, token, `/api/runs/${tuiState.activeRunId}/cancel`, { method: 'POST' });
      setNotice('Cancellation requested');
      return;
    }
    if (command === 'resume') {
      if (!thread) throw new Error('Select a thread first.');
      const state = await request<{ run?: { id: string; status: string } }>(
        baseUrl,
        token,
        `/api/threads/${thread.id}/run-state`,
      );
      if (!state.run || !['failed', 'cancelled'].includes(state.run.status))
        throw new Error('No interrupted run available to resume.');
      openPicker('Resume interrupted run?', [
        { id: 'dismiss', label: 'Back · keep stopped' },
        {
          id: `resume:${state.run.id}`,
          label: 'Resume this run',
          detail: state.run.id,
        },
      ]);
      return;
    }
    if (command === 'skills' || command === 'plugins') {
      await loadCatalog(baseUrl, token, true, `/api/${command}`);
      openPicker(
        command === 'skills' ? 'Skills · select to toggle' : 'Trusted plugins · select to toggle',
        toggleItems(command),
      );
      return;
    }
    if (command === 'remember') {
      if (!argument) {
        setInput('/remember ');
        navigation.close();
        setNotice('Type the memory to save, then Enter.');
        return;
      }
      await request(baseUrl, token, '/api/memory', {
        method: 'POST',
        body: JSON.stringify({ content: argument }),
      });
      setNotice('Memory saved');
      return;
    }
    if (command === 'schedule') {
      if (!argument) {
        navigation.pushForm(scheduleForm());
        setNotice('');
        return;
      }
      const schedule = parseScheduleCommand(argument, 'create');
      await request(baseUrl, token, '/api/schedules', {
        method: 'POST',
        body: JSON.stringify(schedule),
      });
      await refresh();
      setNotice('Schedule saved');
      return;
    }
    if (command === 'refresh') {
      const result = await refresh();
      if (!result.ok) throw new Error(result.error ?? 'Runtime refresh was not confirmed.');
      if (tuiState.view === 'settings')
        setRuntimeStatus(await request<TuiRuntimeSummary>(baseUrl, token, '/api/status'));
      setPicker((current) => (current ? refreshMenu(current) : current));
      setNotice('Runtime refreshed');
      return;
    }
    const views: Record<string, TuiView> = {
      chat: 'conversation',
      status: 'settings',
      help: 'help',
      tasks: 'tasks',
      schedules: 'schedules',
      memory: 'memory',
    };
    if (views[command]) {
      navigation.close();
      dispatch({ type: 'view.changed', view: views[command] });
      return;
    }
    throw new Error(`Unknown command /${command}. Use /help or type / to browse.`);
  };
  const executeCommand = async (value: string, preserveDraft = false): Promise<void> => {
    const parsed = parseCommand(value);
    if (!parsed) return;
    const submitted = draft;
    const threadId = selectedThreadRef.current;
    const cleared = { text: '', cursor: 0 };
    if (!preserveDraft) setDraft(cleared);
    try {
      await executeParsedCommand(parsed, preserveDraft);
    } catch (cause) {
      if (!preserveDraft && threadId === selectedThreadRef.current) {
        setDraft((current) => (current === cleared ? submitted : current));
        setNotice('Command failed · input kept; check saved state before retrying writes.');
      }
      throw cause;
    }
  };
  const slashItems = input.startsWith('/') && !/\s/u.test(input) ? commandMatches(input) : [];
  const slashPicker: PickerState | null =
    input.startsWith('/') && !/\s/u.test(input)
      ? {
          title: 'Commands',
          query: '',
          index: Math.min(commandIndex, Math.max(0, slashItems.length - 1)),
          items: slashItems.map((entry) => ({
            id: `command:${entry.command}`,
            label: `/${entry.command}`,
            detail: `${entry.description} · ${entry.usage}${shortcutHint(entry.command) ? ` · ${shortcutHint(entry.command)}` : ''}`,
          })),
        }
      : null;

  const conversationVisible = !form && !picker && !slashPicker && tuiState.view === 'conversation';
  const approvalBanner =
    tuiState.approvals.length > 0 &&
    (!conversationVisible || tuiState.approvals.length > chatApprovals.length);
  const footerRows =
    Number(busy) +
    Number(Boolean(notice)) +
    Number(!form && !picker && !slashPicker && tuiState.view !== 'conversation');
  // Ink's terminating newline needs the final terminal row, not application content.
  const frameRows = Math.max(1, rows - 1);
  const contentRows = Math.max(
    0,
    frameRows -
      5 -
      footerRows -
      Number(Boolean(tuiState.retry)) -
      Number(approvalBanner) -
      errors.length -
      Number(Boolean(tuiState.catalogErrors?.length)),
  );
  const minimumRows = conversationVisible
    ? (chatApprovals.length ? 10 : 7) + Number(composer.attachments.length > 0)
    : form
      ? 20
      : slashPicker
        ? 11
        : 10;
  const resizeRequired = columns < 34 || contentRows < minimumRows;

  useInput(
    (character, key) => {
      if (key.ctrl && character === 'c') {
        exit();
        return;
      }
      if (resizeRequired) return;
      const wheel = /^\[<(64|65);\d+;\d+[Mm]$/.exec(character);
      if (wheel) {
        const delta = wheel[1] === '64' ? 3 : -3;
        if (picker) {
          const items = pickerMatches(picker);
          setPicker({
            ...picker,
            index: Math.max(0, Math.min(items.length - 1, picker.index - delta)),
          });
        } else if (form || tuiState.view !== 'conversation') {
          setPanelOffset((offset) => Math.max(0, Math.min(panelExtent, offset - delta)));
        } else {
          setHistoryOffset((offset) => Math.max(0, Math.min(historyExtent, offset + delta)));
        }
        return;
      }
      if (form && (key.pageUp || key.pageDown)) {
        setPanelOffset((current) =>
          Math.max(0, Math.min(panelExtent, current + (key.pageUp ? 5 : -5))),
        );
        return;
      }
      if (form) {
        if (key.escape) {
          backMenu();
          setNotice('Left automation editor · saved changes are retained');
          return;
        }
        if (key.ctrl && character === 'b') {
          const next = Math.max(0, form.step - 1);
          const values = [...form.values];
          values[form.step] = input;
          setForm({ ...form, values, step: next });
          setInput(values[next]);
          return;
        }
        if (key.return && (key.meta || key.shift)) {
          setDraft((current) => editDraft(current, '\n', {}));
          return;
        }
        if (key.return) {
          if (!input.trim()) {
            setError('This field is required.');
            return;
          }
          if (
            form.step === 1 &&
            !['manual', 'interval', 'cron', 'once', 'startup'].includes(input.trim())
          ) {
            setError('Choose manual, interval, cron, once, or startup.');
            return;
          }
          setError(null);
          if (form.step < scheduleFields.length - 1) {
            const values = [...form.values];
            values[form.step] = input.trim();
            if (form.step === 1 && !form.original)
              values[2] = (
                {
                  manual: 'manual',
                  startup: 'startup',
                  interval: '5m',
                  cron: '0 9 * * *',
                  once: '',
                } as Record<string, string>
              )[values[1]];
            setForm({ ...form, values, step: form.step + 1 });
            setInput(values[form.step + 1]);
          } else {
            try {
              const draft = scheduleFromForm(form, input);
              openPicker(
                'Review automation',
                [
                  { id: 'dismiss', label: 'Back · do not save' },
                  { id: `save-schedule:${JSON.stringify(draft)}`, label: 'Save automation' },
                ],
                [
                  `Name: ${draft.name}`,
                  `${draft.type} · ${draft.expression}`,
                  draft.agentInput,
                  draft.enabled ? 'Enabled after saving' : 'Remains paused',
                ],
              );
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }
          return;
        }
        setDraft((current) => editDraft(current, character, key));
        return;
      }
      // Never make an approval decision through a picker or a slash-command overlay.
      // Ctrl-N remains denial while a card exists, even when it is obscured.
      if (key.ctrl && character === 'n' && chatApprovals.length && !conversationVisible) {
        setNotice('Close the menu with Esc to review the approval before denying.');
        return;
      }
      const shortcut = resolveTuiShortcut(character, key);
      if (shortcut && !(key.ctrl && character === 'n' && selectedApproval)) {
        runAction(() => executeCommand(`/${shortcut.command}`, true));
        return;
      }
      if (picker) {
        if (key.escape) {
          if (!busy) backMenu();
          return;
        }
        if (busy) return;
        if (key.ctrl && character === 'u') {
          setPicker({ ...picker, query: '', index: 0 });
          return;
        }
        if (key.pageUp || key.pageDown) {
          setPicker({
            ...picker,
            detailOffset: Math.max(
              0,
              Math.min(pickerDetailExtent, (picker.detailOffset ?? 0) + (key.pageDown ? 4 : -4)),
            ),
          });
          return;
        }
        const items = pickerMatches(picker);
        if (key.upArrow || key.downArrow) {
          setPicker({
            ...picker,
            index: Math.max(
              0,
              Math.min(Math.max(0, items.length - 1), picker.index + (key.downArrow ? 1 : -1)),
            ),
          });
          return;
        }
        if (key.return) {
          const item = items[Math.min(picker.index, items.length - 1)];
          if (item && !item.disabled) runAction(() => chooseItem(item.id));
          return;
        }
        if (key.backspace || key.delete)
          setPicker({ ...picker, query: [...picker.query].slice(0, -1).join(''), index: 0 });
        else if (!key.ctrl && !key.meta && character)
          setPicker({ ...picker, query: picker.query + character, index: 0 });
        return;
      }
      if (key.meta && (key.upArrow || key.downArrow) && selectedApproval) {
        setApprovalDetailOffset((offset) =>
          Math.max(0, Math.min(approvalDetailExtent, offset + (key.downArrow ? 2 : -2))),
        );
        return;
      }
      if (
        ((key.ctrl && (character === 'y' || character === 'n')) ||
          (key.meta && character === 'g')) &&
        conversationVisible
      ) {
        if (!selectedApproval) {
          setNotice('No pending approval in this conversation.');
          return;
        }
        if (selectedApproval.expiresAt <= Date.now()) {
          setError('This approval has expired. Refresh before continuing.');
          runAction(async () => {
            await refresh();
          });
          return;
        }
        runAction(() =>
          chooseItem(
            `decision:${JSON.stringify([selectedApproval.id, selectedApproval.payloadHash, character === 'n' ? 'deny' : 'approve', key.meta ? 'session' : 'once'])}`,
          ),
        );
        return;
      }
      if (key.tab && !input && chatApprovals.length > 1 && tuiState.view === 'conversation') {
        setApprovalIndex((index) => (index + 1) % chatApprovals.length);
        setHistoryOffset(0);
        return;
      }
      if (key.escape) {
        setInput('');
        setError(null);
        setNotice('');
        setCommandIndex(0);
        dispatch({ type: 'view.changed', view: 'conversation' });
        return;
      }
      if (key.pageUp || key.pageDown) {
        if (tuiState.view !== 'conversation') {
          setPanelOffset((offset) =>
            Math.max(0, Math.min(panelExtent, offset + (key.pageDown ? 8 : -8))),
          );
          return;
        }
        if (key.pageUp && historyOffset >= historyExtent && historyPage.current.hasMore) {
          void loadOlder();
          return;
        }
        setHistoryOffset((offset) =>
          Math.max(0, Math.min(historyExtent, offset + (key.pageUp ? 8 : -8))),
        );
        return;
      }
      if (key.ctrl && key.end && tuiState.view === 'conversation') {
        setHistoryOffset(0);
        return;
      }
      if (key.ctrl && (key.upArrow || key.downArrow)) {
        const id = nextSelection(
          tuiState.selectedSessionId,
          sessions.map((entry) => entry.id),
          key.downArrow ? 1 : -1,
        );
        if (id) runAction(() => chooseItem(`session:${id}`));
        return;
      }
      if (key.ctrl && (key.leftArrow || key.rightArrow)) {
        const id = nextSelection(
          thread?.id ?? null,
          threads
            .filter((entry) => entry.sessionId === tuiState.selectedSessionId)
            .map((entry) => entry.id),
          key.rightArrow ? 1 : -1,
        );
        if (id) runAction(() => chooseItem(`thread:${id}`));
        return;
      }
      if (slashPicker && (key.upArrow || key.downArrow)) {
        setCommandIndex((index) =>
          Math.max(0, Math.min(slashItems.length - 1, index + (key.downArrow ? 1 : -1))),
        );
        return;
      }
      if (slashPicker && key.tab) {
        const selected = slashItems[Math.min(commandIndex, slashItems.length - 1)];
        if (selected) setInput(`/${selected.command} `);
        return;
      }
      if (key.tab && input.startsWith('/attach ')) {
        runAction(() => showAttachmentPaths(input.slice(8)));
        return;
      }
      if (key.return && (key.meta || key.shift)) {
        setDraft((current) => editDraft(current, '\n', {}));
        return;
      }
      if (key.return) {
        if (busy) return;
        if (slashPicker && slashItems.length) {
          const selected = slashItems[Math.min(commandIndex, slashItems.length - 1)];
          runAction(() => executeCommand(`/${selected.command}`));
          return;
        }
        if (input.trim().startsWith('/')) {
          runAction(() => executeCommand(input));
          return;
        }
        if (tuiState.view !== 'conversation') {
          setNotice('Use /chat to return to the conversation, or / for commands.');
          return;
        }
        const value = input.trim() || (composer.attachments.length ? 'Attached files' : '');
        if (!value || !thread) return;
        if (tuiState.connection !== 'connected') {
          setError('Daemon disconnected. Use /refresh to reconnect.');
          return;
        }
        const threadId = thread.id;
        const submittedDraft = draft;
        const attachments = composer.attachments;
        const identity = JSON.stringify([threadId, value, attachments]);
        runAction(async () => {
          const idempotencyKey = composer.submissionKey(threadId, identity);
          const accepted = await request<{ id: string }>(baseUrl, token, '/api/runs', {
            method: 'POST',
            body: JSON.stringify({ threadId, input: value, idempotencyKey, attachments }),
          }).catch((cause: unknown) => {
            if (selectedThreadRef.current === threadId)
              setNotice('Run acceptance uncertain · Enter retries the same submission safely');
            throw cause;
          });
          if (!accepted.id)
            throw new Error(
              'Run acceptance was not confirmed. Retry uses the same submission key.',
            );
          composer.accept(threadId, value, submittedDraft, attachments, identity);
          historyIndex.current = -1;
          if (selectedThreadRef.current === threadId) {
            setHistoryOffset(0);
            setNotice(`Run accepted · ${accepted.id.slice(0, 8)}`);
          }
          await refresh();
        });
        return;
      }
      if (
        key.meta &&
        (key.upArrow || key.downArrow) &&
        tuiState.view === 'conversation' &&
        !input.includes('\n') &&
        sentHistory.current.length
      ) {
        if (historyIndex.current === -1) historyDraft.current = input;
        const next = key.upArrow
          ? Math.min(sentHistory.current.length - 1, historyIndex.current + 1)
          : Math.max(-1, historyIndex.current - 1);
        historyIndex.current = next;
        setInput(
          next === -1
            ? historyDraft.current
            : sentHistory.current[sentHistory.current.length - 1 - next],
        );
        return;
      }
      if ((key.upArrow || key.downArrow) && !key.ctrl && !key.meta && !input.includes('\n')) {
        const delta = key.upArrow ? 3 : -3;
        if (tuiState.view === 'conversation')
          setHistoryOffset((offset) => Math.max(0, Math.min(historyExtent, offset + delta)));
        else setPanelOffset((offset) => Math.max(0, Math.min(panelExtent, offset - delta)));
        return;
      }
      setCommandIndex(0);
      historyIndex.current = -1;
      setDraft((current) => editDraft(current, character, key));
    },
    { isActive: isRawModeSupported },
  );

  const renderPanel = (): React.JSX.Element => {
    if (tuiState.view === 'settings' && runtimeStatus)
      return <TuiRuntimeStatus endpoint={baseUrl} status={runtimeStatus} />;
    if (tuiState.view === 'conversation')
      return (
        <TuiConversation
          height={contentRows}
          activeRunId={tuiState.activeRunId}
          approvals={chatApprovals}
          selectedApprovalId={selectedApproval?.id}
          approvalDetailOffset={approvalDetailOffset}
          onApprovalDetailExtent={setApprovalDetailExtent}
          columns={columns - 2}
          onHistoryExtent={setHistoryExtent}
          focus={searchFocus}
          onFocus={setHistoryOffset}
          title={
            thread
              ? `${thread.title} · approvals: ${sessionPolicy?.sessionId === tuiState.selectedSessionId ? sessionPolicy.mode : 'unavailable'} · ${sessionIdentity ? `identity r${sessionIdentity.revision} · /identity` : identityError ? 'identity status unavailable · /identity' : 'identity status pending'}`
              : 'Connecting to your runtime…'
          }
          messages={messages}
          stream={stream}
          input={input}
          attachments={composer.attachments.map((attachment) => attachment.name)}
          historyOffset={historyOffset}
          tools={tuiState.tools}
          cursor={draft.cursor}
          compact={preferences.compact}
          toolDetails={preferences.toolDetails}
        />
      );
    return <Text dimColor>Use / to browse commands, or /chat to return to the conversation.</Text>;
  };

  if (resizeRequired)
    return (
      <Box height={frameRows} width={Math.max(1, columns)} overflow="hidden" flexDirection="column">
        <Text wrap="truncate-end">Resize terminal · Ctrl-C exit</Text>
      </Box>
    );
  return (
    <Box flexDirection="column" padding={1} width={columns} height={frameRows} overflow="hidden">
      <Text color="blue" bold>
        NUAAI
      </Text>
      <Text dimColor wrap="truncate-end">
        {terminalText(status).replaceAll('\n', ' ')}
        {tuiState.provider ? ` · ${tuiState.provider.name}/${tuiState.provider.model}` : ''}
        {chatApprovals.length
          ? ' · Alt-H help · Ctrl-N deny · Ctrl-P models · Ctrl-C quit'
          : ' · Alt-H help · Ctrl-N new · Ctrl-P models · Ctrl-C quit'}
        {tuiState.activeRunId
          ? ' · Working…'
          : tuiState.lastRunStatus
            ? ` · ${tuiState.lastRunStatus}`
            : ''}
      </Text>
      {tuiState.retry && (
        <Text color="yellow" wrap="truncate-end">
          Retrying task {tuiState.retry.taskId} ({tuiState.retry.attempt}/
          {tuiState.retry.maxAttempts})
        </Text>
      )}
      {approvalBanner && (
        <Text color="yellow" wrap="truncate-end">
          {tuiState.approvals.length} action(s) need approval · /approvals focuses the chat card
        </Text>
      )}
      {errors.map((error) => (
        <Text key={error} color="red" wrap="truncate-end">
          Error: {terminalText(error).replaceAll('\n', ' ')}
        </Text>
      ))}
      {Boolean(tuiState.catalogErrors?.length) && (
        <Text color="yellow" wrap="truncate-end">
          Catalog unavailable · {tuiState.catalogErrors?.join(' · ')}
        </Text>
      )}
      <Box flexDirection="column" marginTop={1} height={contentRows + footerRows} overflow="hidden">
        {form ? (
          <TuiViewport height={contentRows} offset={panelOffset} onExtent={setPanelExtent}>
            <TuiScheduleForm
              form={form}
              input={input}
              cursor={draft.cursor}
              columns={columns - 2}
            />
          </TuiViewport>
        ) : picker ? (
          <TuiPicker
            picker={picker}
            busy={busy}
            height={contentRows}
            onDetailExtent={setPickerDetailExtent}
          />
        ) : slashPicker ? (
          <>
            <TuiEditor input={input} cursor={draft.cursor} columns={columns - 2} maxRows={1} />
            <TuiPicker picker={slashPicker} busy={busy} height={Math.max(0, contentRows - 3)} />
          </>
        ) : tuiState.view === 'conversation' ? (
          renderPanel()
        ) : (
          <TuiViewport
            height={contentRows}
            offset={panelOffset}
            anchor="start"
            onExtent={setPanelExtent}
          >
            {renderPanel()}
          </TuiViewport>
        )}
        {!form && !picker && !slashPicker && tuiState.view !== 'conversation' && (
          <Text color="blue">› {input}▌</Text>
        )}
        {busy && <Text color="blue">Applying…</Text>}
        {notice && (
          <Text dimColor wrap="truncate-end">
            {terminalText(notice).replaceAll('\n', ' ')}
          </Text>
        )}
      </Box>
    </Box>
  );
}
