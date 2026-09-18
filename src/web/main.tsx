import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  isAuthenticationErrorMessage,
  isRequestAbort,
  pairingFailureMessage,
  parseApiResponse,
  webSocketCloseDisposition,
} from './auth.js';
import { AgentComposer } from './components/AgentComposer.js';
import { ArtifactCards } from './components/ArtifactCards.js';
import { MarkdownContent } from './components/MarkdownContent.js';
import { RunStatusSummary } from './components/RunStatusSummary.js';
import { type ComposerCommand, draftStorageKey, resolveComposerCommand } from './composer.js';
import type {
  ActiveProvider,
  ApprovalRequest,
  CommandId,
  ConnectionState,
  MemoryRecord,
  MessageView,
  PermissionProfile,
  PluginHealth,
  PluginRecord,
  ProviderHealth,
  Schedule,
  Session,
  SkillRecord,
  Task,
  Thread,
  ThreadPresentation,
  ViewId,
} from './contracts.js';
import {
  connectionLabel,
  displayModel,
  newConversationTitle,
  providerUnavailableNotice,
  relativeTime,
  runLabel,
} from './format.js';
import { groupSessionsForRail } from './navigation.js';
import {
  isNearScrollBottom,
  preserveScrollAnchor,
  shouldFollowNewOutput,
  shouldShowNewResponseButton,
} from './scroll.js';
import {
  type ActiveRunsByThread,
  EventReplayBuffer,
  EventReplayCursor,
  type LiveOutputByRun,
  type QueuedRunsByThread,
  type SelectionIdentity,
  type SelectionLoad,
  SelectionLoadCoordinator,
  type ThreadRunState,
  type WebEventRecord,
  activeRunForThread,
  liveOutputSnapshot,
  loadReplaySafeThreadSnapshot,
  projectRunEvents,
  reduceActiveRunsByThread,
  reduceLiveOutputByRun,
  reduceQueuedRunsByThread,
  runStateSnapshotCanReplaceLiveState,
  selectionIdentityMatches,
  selectionSnapshotCanCommit,
} from './state.js';
import {
  ApprovalInbox,
  AutomationsView,
  CommandPalette,
  ErrorToast,
  MemoryView,
  NavigationTabs,
  SystemView,
} from './views.js';
import './styles.css';

const APP_BASE_PATH =
  window.location.pathname === '/nuaai' || window.location.pathname.startsWith('/nuaai/')
    ? '/nuaai/'
    : '/';

const terminalRunStates = new Set(['completed', 'failed', 'cancelled']);

function appPath(path: string): string {
  return `${APP_BASE_PATH}${path.replace(/^\//, '')}`;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(appPath(path), {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  return parseApiResponse<T>(response);
}

function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [events, setEvents] = useState<WebEventRecord[]>([]);
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [activeProvider, setActiveProvider] = useState<ActiveProvider | null>(null);
  const [webPermissionProfile, setWebPermissionProfile] = useState<PermissionProfile>('read-only');
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [pluginHealth, setPluginHealth] = useState<PluginHealth[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [decidingApprovalIds, setDecidingApprovalIds] = useState<Set<string>>(new Set());
  const [view, setView] = useState<ViewId>('conversation');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [input, setInput] = useState('');
  const [activeRunsByThread, setActiveRunsByThread] = useState<ActiveRunsByThread>({});
  const [liveOutputByRun, setLiveOutputByRun] = useState<LiveOutputByRun>({});
  const [queuedRunsByThread, setQueuedRunsByThread] = useState<QueuedRunsByThread>({});
  const [queuedPromptsByRun, setQueuedPromptsByRun] = useState<Record<string, string>>({});
  const [eventSubscription, setEventSubscription] = useState<{
    sessionId: string;
    after: number;
    generation: number;
  } | null>(null);
  const [scheduleName, setScheduleName] = useState('');
  const [scheduleInput, setScheduleInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showNewResponse, setShowNewResponse] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false);
  const [loadingEarlierMessages, setLoadingEarlierMessages] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');

  const selectedSessionRef = useRef<string | null>(null);
  const selectedThreadRef = useRef<string | null>(null);
  const lastEventId = useRef(0);
  const selectionLoads = useRef(new SelectionLoadCoordinator());
  const backgroundLoads = useRef(new SelectionLoadCoordinator());
  const snapshotEpoch = useRef(0);
  const snapshotEpochByLoad = useRef(new WeakMap<SelectionLoad, number>());
  const pollGeneration = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const sessionRailRef = useRef<HTMLElement>(null);
  const followFrameRef = useRef<number | null>(null);
  const historyFrameRef = useRef<number | null>(null);
  const nearBottomRef = useRef(true);
  const forceFollowRef = useRef(true);
  const draftHydrationRef = useRef<{ threadId: string; value: string } | null>(null);
  const paletteFirstActionRef = useRef<HTMLButtonElement>(null);
  const decidingApprovalIdsRef = useRef(new Set<string>());
  const activeRunId = activeRunForThread(activeRunsByThread, selectedThreadId);
  const authenticationError = isAuthenticationErrorMessage(error);

  const reportBackgroundFailure = useCallback((cause: unknown): void => {
    if (isRequestAbort(cause)) return;
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const registerSnapshotLoad = useCallback((load: SelectionLoad): SelectionLoad => {
    const epoch = snapshotEpoch.current + 1;
    snapshotEpoch.current = epoch;
    snapshotEpochByLoad.current.set(load, epoch);
    return load;
  }, []);

  const snapshotCanCommit = useCallback(
    (
      coordinator: SelectionLoadCoordinator,
      load: SelectionLoad,
      expected: SelectionIdentity,
      current: SelectionIdentity,
    ): boolean => {
      const loadEpoch = snapshotEpochByLoad.current.get(load);
      return (
        loadEpoch !== undefined &&
        selectionSnapshotCanCommit(
          coordinator,
          load,
          expected,
          current,
          loadEpoch,
          snapshotEpoch.current,
        )
      );
    },
    [],
  );

  const snapshotLoadIsCurrent = useCallback(
    (coordinator: SelectionLoadCoordinator, load: SelectionLoad): boolean => {
      const loadEpoch = snapshotEpochByLoad.current.get(load);
      return (
        loadEpoch !== undefined &&
        loadEpoch === snapshotEpoch.current &&
        coordinator.isCurrent(load)
      );
    },
    [],
  );

  const beginForegroundLoad = useCallback(
    (selection: SelectionIdentity): SelectionLoad => {
      backgroundLoads.current.cancel();
      if (historyFrameRef.current !== null) {
        window.cancelAnimationFrame(historyFrameRef.current);
        historyFrameRef.current = null;
      }
      return registerSnapshotLoad(selectionLoads.current.begin(selection));
    },
    [registerSnapshotLoad],
  );

  const beginBackgroundLoad = useCallback(
    (selection: SelectionIdentity): SelectionLoad =>
      registerSnapshotLoad(backgroundLoads.current.begin(selection)),
    [registerSnapshotLoad],
  );

  const clearThreadView = useCallback((): void => {
    setMessages([]);
    setEvents([]);
    setLiveOutputByRun({});
    setHistoryCursor(null);
    setHasEarlierMessages(false);
    setLoadingEarlierMessages(false);
    setEventSubscription(null);
    setShowNewResponse(false);
    setNotice(null);
    lastEventId.current = 0;
  }, []);

  const followNextOutput = (): void => {
    forceFollowRef.current = true;
    nearBottomRef.current = true;
    setShowNewResponse(false);
  };

  const scrollToLatest = (): void => {
    const scroller = messagesRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    forceFollowRef.current = false;
    nearBottomRef.current = true;
    setShowNewResponse(false);
  };

  useEffect(() => {
    selectedSessionRef.current = selectedSessionId;
  }, [selectedSessionId]);
  useEffect(() => {
    selectedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);
  useEffect(
    () => () => {
      selectionLoads.current.cancel();
      backgroundLoads.current.cancel();
      if (historyFrameRef.current !== null) window.cancelAnimationFrame(historyFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!sessionDrawerOpen) return;
    const rail = sessionRailRef.current;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      rail?.querySelector<HTMLElement>('button, input, [tabindex="0"]')?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setSessionDrawerOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', closeOnEscape);
      previousFocus?.focus();
    };
  }, [sessionDrawerOpen]);

  useEffect(() => {
    const key = draftStorageKey(selectedThreadId);
    if (!key || !selectedThreadId) {
      setInput('');
      return;
    }
    try {
      const value = window.localStorage.getItem(key) ?? '';
      draftHydrationRef.current = { threadId: selectedThreadId, value };
      setInput(value);
    } catch (cause) {
      setInput('');
      setError(
        `Draft storage is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }, [selectedThreadId]);

  useEffect(() => {
    const key = draftStorageKey(selectedThreadId);
    if (!key || !selectedThreadId) return;
    const hydration = draftHydrationRef.current;
    if (hydration?.threadId === selectedThreadId) {
      if (input !== hydration.value) return;
      draftHydrationRef.current = null;
    }
    try {
      if (input) window.localStorage.setItem(key, input);
      else window.localStorage.removeItem(key);
    } catch (cause) {
      setError(
        `Draft could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }, [input, selectedThreadId]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (commandPaletteOpen) paletteFirstActionRef.current?.focus();
  }, [commandPaletteOpen]);

  const loadSystem = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const [
      providerResult,
      scheduleResult,
      taskResult,
      memoryResult,
      skillResult,
      pluginResult,
      approvalResult,
    ] = await Promise.all([
      request<{
        active: ActiveProvider;
        providers: ProviderHealth[];
        webPermissionProfile?: PermissionProfile;
      }>('/api/providers', { signal }),
      request<{ schedules: Schedule[] }>('/api/schedules', { signal }),
      request<{ tasks: Task[] }>('/api/tasks', { signal }),
      request<{ memories: MemoryRecord[] }>('/api/memory', { signal }),
      request<{ skills: SkillRecord[] }>('/api/skills', { signal }),
      request<{ plugins: PluginRecord[]; health: PluginHealth[] }>('/api/plugins', { signal }),
      request<{ approvals: ApprovalRequest[] }>('/api/approvals?status=pending', { signal }),
    ]);
    setWebPermissionProfile(providerResult.webPermissionProfile ?? 'read-only');
    setProviders(providerResult.providers);
    setActiveProvider(providerResult.active);
    setSchedules(scheduleResult.schedules);
    setTasks(taskResult.tasks);
    setMemories(memoryResult.memories);
    setSkills(skillResult.skills);
    setPlugins(pluginResult.plugins);
    setPluginHealth(pluginResult.health);
    setApprovals(approvalResult.approvals);
  }, []);

  const loadThread = useCallback(
    async (
      threadId: string,
      load: SelectionLoad,
      coordinator = selectionLoads.current,
      expectedSelection: SelectionIdentity = {
        sessionId: selectedSessionRef.current,
        threadId,
      },
      subscriptionWillReset = false,
    ): Promise<ThreadRunState | null> => {
      const { runState, presentation } = await loadReplaySafeThreadSnapshot(
        () =>
          request<ThreadRunState>(`/api/threads/${encodeURIComponent(threadId)}/run-state`, {
            signal: load.signal,
          }),
        () =>
          request<ThreadPresentation>(`/api/threads/${encodeURIComponent(threadId)}/presentation`, {
            signal: load.signal,
          }),
      );
      if (
        !snapshotCanCommit(coordinator, load, expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        })
      )
        return null;
      setMessages(presentation.messages);
      setHistoryCursor(presentation.nextCursor);
      setHasEarlierMessages(presentation.hasMore);
      setLoadingEarlierMessages(false);
      const replaceLiveState = runStateSnapshotCanReplaceLiveState(
        runState.lastEventId,
        lastEventId.current,
        subscriptionWillReset,
      );
      if (replaceLiveState) {
        setEvents(runState.events);
        setLiveOutputByRun(liveOutputSnapshot(runState));
        setActiveRunsByThread((current) => ({
          ...current,
          [threadId]: runState.activeRunId,
        }));
        setQueuedRunsByThread((current) => ({
          ...current,
          [threadId]: runState.queuedRunIds,
        }));
        setQueuedPromptsByRun((current) => ({
          ...current,
          ...Object.fromEntries(runState.queuedRuns.map((run) => [run.id, run.input])),
        }));
        lastEventId.current = Math.max(lastEventId.current, runState.lastEventId);
      }
      return runState;
    },
    [snapshotCanCommit],
  );

  const loadSession = useCallback(
    async (
      sessionId: string,
      load: SelectionLoad,
      preferredThreadId?: string | null,
    ): Promise<boolean> => {
      const detail = await request<{ threads: Thread[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        { signal: load.signal },
      );
      if (
        !snapshotLoadIsCurrent(selectionLoads.current, load) ||
        selectedSessionRef.current !== sessionId
      )
        return false;
      setThreads(detail.threads);
      const currentThreadId =
        preferredThreadId === undefined ? selectedThreadRef.current : preferredThreadId;
      const nextThread =
        detail.threads.find((thread) => thread.id === currentThreadId) ?? detail.threads[0] ?? null;
      if (!nextThread || nextThread.id !== selectedThreadRef.current) clearThreadView();
      setSelectedThreadId(nextThread?.id ?? null);
      selectedThreadRef.current = nextThread?.id ?? null;
      if (!nextThread) return true;

      const runState = await loadThread(
        nextThread.id,
        load,
        selectionLoads.current,
        { sessionId, threadId: nextThread.id },
        true,
      );
      if (
        !runState ||
        !snapshotCanCommit(
          selectionLoads.current,
          load,
          { sessionId, threadId: nextThread.id },
          {
            sessionId: selectedSessionRef.current,
            threadId: selectedThreadRef.current,
          },
        )
      )
        return false;
      setEventSubscription({
        sessionId,
        after: runState.lastEventId,
        generation: load.generation,
      });
      return true;
    },
    [clearThreadView, loadThread, snapshotCanCommit, snapshotLoadIsCurrent],
  );

  const refresh = useCallback(
    async (preferredSessionId?: string | null): Promise<boolean> => {
      const load = beginForegroundLoad({
        sessionId: preferredSessionId ?? selectedSessionRef.current,
        threadId: selectedThreadRef.current,
      });
      try {
        const sessionResult = await request<{ sessions: Session[] }>('/api/sessions', {
          signal: load.signal,
        });
        if (!snapshotLoadIsCurrent(selectionLoads.current, load)) return false;
        setSessions(sessionResult.sessions);
        const requestedId = preferredSessionId ?? selectedSessionRef.current;
        const nextSession =
          sessionResult.sessions.find((session) => session.id === requestedId) ??
          sessionResult.sessions[0] ??
          null;
        if (!nextSession || nextSession.id !== selectedSessionRef.current) {
          setThreads([]);
          setSelectedThreadId(null);
          selectedThreadRef.current = null;
          clearThreadView();
        }
        setSelectedSessionId(nextSession?.id ?? null);
        selectedSessionRef.current = nextSession?.id ?? null;
        const [sessionLoaded] = await Promise.all([
          nextSession ? loadSession(nextSession.id, load) : Promise.resolve(true),
          loadSystem(load.signal),
        ]);
        if (!nextSession) {
          setThreads([]);
          setSelectedThreadId(null);
          selectedThreadRef.current = null;
          clearThreadView();
        }
        if (!snapshotLoadIsCurrent(selectionLoads.current, load) || !sessionLoaded) return false;
        setConnection('connected');
        setError(null);
        return true;
      } catch (cause) {
        if (!snapshotLoadIsCurrent(selectionLoads.current, load)) return false;
        setConnection('offline');
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    },
    [beginForegroundLoad, clearThreadView, loadSession, loadSystem, snapshotLoadIsCurrent],
  );

  useEffect(() => {
    const pairingToken = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (!pairingToken) {
      void refresh();
      return;
    }
    window.history.replaceState(
      null,
      document.title,
      `${window.location.pathname}${window.location.search}`,
    );
    void request('/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ token: pairingToken }),
    })
      .then(() => refresh())
      .catch((cause: unknown) => {
        setConnection('offline');
        setError(pairingFailureMessage(cause));
      });
  }, [refresh]);

  useEffect(() => {
    if (!eventSubscription) return;
    const subscribedSessionId = eventSubscription.sessionId;
    let stopped = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let eventFrame: number | undefined;
    const eventBuffer = new EventReplayBuffer();
    const replayCursor = new EventReplayCursor(eventSubscription.after);
    let retry = 0;
    lastEventId.current = eventSubscription.after;

    const flushEvents = (): void => {
      eventFrame = undefined;
      const batch = eventBuffer.drain();
      if (!batch.length) return;
      setActiveRunsByThread((current) => batch.reduce(reduceActiveRunsByThread, current));
      setLiveOutputByRun((current) => batch.reduce(reduceLiveOutputByRun, current));
      setQueuedRunsByThread((current) => batch.reduce(reduceQueuedRunsByThread, current));
      setQueuedPromptsByRun((current) => {
        const next = { ...current };
        for (const event of batch) {
          if (
            event.runId &&
            event.type === 'run.created' &&
            typeof event.payload.input === 'string'
          )
            next[event.runId] = event.payload.input;
          if (
            event.runId &&
            (event.type === 'run.started' || terminalRunStates.has(event.type.replace('run.', '')))
          )
            delete next[event.runId];
        }
        return next;
      });
      setEvents((current) => {
        const next = [...current];
        const seen = new Set(current.flatMap((event) => (event.id ? [event.id] : [])));
        for (const event of batch) {
          if (event.threadId && event.threadId !== selectedThreadRef.current) continue;
          if (event.id && seen.has(event.id)) continue;
          if (event.id) seen.add(event.id);
          next.push(event);
        }
        return next.slice(-500);
      });
    };

    const scheduleEvent = (event: WebEventRecord): void => {
      if (!eventBuffer.add(event)) return;
      if (!replayCursor.isReplaying()) eventFrame ??= window.requestAnimationFrame(flushEvents);
    };

    const subscribe = (after: number): void => {
      socket?.send(
        JSON.stringify({
          type: 'subscribe',
          sessionId: subscribedSessionId,
          after,
          limit: 250,
        }),
      );
    };

    const connect = (): void => {
      if (stopped) return;
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${location.host}${appPath('/ws')}`);
      socket.onopen = () => {
        retry = 0;
        setConnection('connected');
        subscribe(replayCursor.beginReplay());
      };
      socket.onmessage = (message) => {
        try {
          const value = JSON.parse(String(message.data)) as {
            type: string;
            event?: WebEventRecord;
            nextCursor?: number;
            hasMore?: boolean;
          };
          if (value.type === 'replay.complete') {
            const continuation = replayCursor.completePage(
              value.nextCursor ?? 0,
              value.hasMore === true,
            );
            lastEventId.current = Math.max(lastEventId.current, replayCursor.highWater());
            if (continuation !== null) subscribe(continuation);
            else if (eventBuffer.size) eventFrame ??= window.requestAnimationFrame(flushEvents);
            return;
          }
          if (value.type !== 'event' || !value.event) return;
          const nextEvent = value.event;
          if (nextEvent.sessionId && nextEvent.sessionId !== subscribedSessionId) return;
          if (nextEvent.id !== undefined) replayCursor.observe(nextEvent.id);
          lastEventId.current = Math.max(lastEventId.current, nextEvent.id ?? 0);
          scheduleEvent(nextEvent);
          if (nextEvent.type.startsWith('approval.'))
            void loadSystem().catch(reportBackgroundFailure);
          if (
            terminalRunStates.has(nextEvent.type.replace('run.', '')) &&
            nextEvent.threadId === selectedThreadRef.current
          ) {
            const sessionId = selectedSessionRef.current;
            const threadId = selectedThreadRef.current;
            if (sessionId && threadId) {
              const expectedSelection = { sessionId, threadId };
              const load = beginBackgroundLoad(expectedSelection);
              void loadThread(threadId, load, backgroundLoads.current, expectedSelection).catch(
                reportBackgroundFailure,
              );
            }
            if (sessionId) void loadSystem().catch(reportBackgroundFailure);
          }
        } catch {
          setError('NUAAI received an invalid live event. Refresh the runtime state.');
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = (event) => {
        if (stopped) return;
        const disposition = webSocketCloseDisposition(event.code, event.reason);
        if (!disposition.reconnect) {
          stopped = true;
          setConnection('offline');
          setError(disposition.message ?? 'Pair this device to continue.');
          return;
        }
        retry += 1;
        setConnection(retry >= 6 ? 'offline' : 'reconnecting');
        reconnectTimer = window.setTimeout(connect, Math.min(1_000 * 2 ** (retry - 1), 10_000));
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (eventFrame) window.cancelAnimationFrame(eventFrame);
      socket?.close();
    };
  }, [beginBackgroundLoad, eventSubscription, loadSystem, loadThread, reportBackgroundFailure]);

  useEffect(() => {
    if (!activeRunId || !selectedThreadId) return;
    const runId = activeRunId;
    const threadId = selectedThreadId;
    const sessionId = selectedSessionRef.current;
    if (!sessionId) return;
    const generation = pollGeneration.current + 1;
    pollGeneration.current = generation;
    const controller = new AbortController();
    const ownsPoll = (): boolean =>
      pollGeneration.current === generation &&
      selectedSessionRef.current === sessionId &&
      selectedThreadRef.current === threadId;
    let nextPausedApprovalRefreshAt = 0;
    const timer = window.setInterval(() => {
      void request<{ status: string }>(`/api/runs/${encodeURIComponent(runId)}`, {
        signal: controller.signal,
      })
        .then((run) => {
          if (!ownsPoll()) return;
          if (run.status === 'paused') {
            const now = Date.now();
            if (now >= nextPausedApprovalRefreshAt) {
              nextPausedApprovalRefreshAt = now + 15_000;
              void loadSystem().catch(reportBackgroundFailure);
            }
            return;
          }
          if (!terminalRunStates.has(run.status)) return;
          setActiveRunsByThread((current) =>
            current[threadId] === runId ? { ...current, [threadId]: null } : current,
          );
          const expectedSelection = { sessionId, threadId };
          const load = beginBackgroundLoad(expectedSelection);
          void loadThread(threadId, load, backgroundLoads.current, expectedSelection).catch(
            reportBackgroundFailure,
          );
          void loadSystem().catch(reportBackgroundFailure);
        })
        .catch((cause: unknown) => {
          if (!ownsPoll() || isRequestAbort(cause)) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    }, 2_000);
    return () => {
      pollGeneration.current += 1;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [
    activeRunId,
    beginBackgroundLoad,
    loadSystem,
    loadThread,
    reportBackgroundFailure,
    selectedThreadId,
  ]);

  useEffect(() => {
    const refreshVisibleApprovals = (): void => {
      if (document.visibilityState === 'visible') void loadSystem().catch(reportBackgroundFailure);
    };
    window.addEventListener('focus', refreshVisibleApprovals);
    document.addEventListener('visibilitychange', refreshVisibleApprovals);
    return () => {
      window.removeEventListener('focus', refreshVisibleApprovals);
      document.removeEventListener('visibilitychange', refreshVisibleApprovals);
    };
  }, [loadSystem, reportBackgroundFailure]);

  const scrollRevision = `${messages.at(-1)?.id ?? ''}:${events.at(-1)?.id ?? ''}`;
  useEffect(() => {
    if (!scrollRevision) return;
    if (
      !shouldFollowNewOutput({
        nearBottom: nearBottomRef.current,
        forceFollow: forceFollowRef.current,
      })
    ) {
      setShowNewResponse(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      followFrameRef.current = null;
      if (
        !shouldFollowNewOutput({
          nearBottom: nearBottomRef.current,
          forceFollow: forceFollowRef.current,
        })
      ) {
        setShowNewResponse(true);
        return;
      }
      const scroller = messagesRef.current;
      if (!scroller) return;
      scroller.scrollTop = scroller.scrollHeight;
      nearBottomRef.current = true;
      forceFollowRef.current = false;
      setShowNewResponse(false);
    });
    followFrameRef.current = frame;
    return () => {
      window.cancelAnimationFrame(frame);
      if (followFrameRef.current === frame) followFrameRef.current = null;
    };
  }, [scrollRevision]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
      } else if (event.key === 'Escape') {
        setCommandPaletteOpen(false);
        setSessionDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const sessionGroups = useMemo(
    () => groupSessionsForRail(sessions, sessionSearch),
    [sessionSearch, sessions],
  );
  const queuedItems = useMemo(
    () =>
      (selectedThreadId ? (queuedRunsByThread[selectedThreadId] ?? []) : [])
        .map((runId) => ({ id: runId, prompt: queuedPromptsByRun[runId] }))
        .filter((item): item is { id: string; prompt: string } => Boolean(item.prompt)),
    [queuedPromptsByRun, queuedRunsByThread, selectedThreadId],
  );
  const threadEvents = useMemo(
    () =>
      events.filter(
        (event) => !event.threadId || !selectedThreadId || event.threadId === selectedThreadId,
      ),
    [events, selectedThreadId],
  );
  const runProjection = useMemo(
    () => projectRunEvents(threadEvents, activeRunId),
    [activeRunId, threadEvents],
  );
  const transcript = useMemo(
    () =>
      messages.filter(
        (message) =>
          ['user', 'assistant'].includes(message.role) &&
          message.markdown.trim() &&
          !(message.role === 'assistant' && message.runId === activeRunId),
      ),
    [activeRunId, messages],
  );
  const liveMessage = useMemo<MessageView | null>(() => {
    if (!runProjection || terminalRunStates.has(runProjection.status)) return null;
    const startedAt =
      threadEvents.find(
        (event) => event.runId === runProjection.runId && event.type === 'run.started',
      )?.createdAt ?? Date.now();
    return {
      id: `run:${runProjection.runId}:assistant`,
      runId: runProjection.runId,
      role: 'assistant',
      markdown: liveOutputByRun[runProjection.runId] ?? runProjection.liveOutput,
      createdAt: startedAt,
      ...(activeProvider ? { provider: activeProvider } : {}),
      status: 'streaming',
      activities: [
        {
          runId: runProjection.runId,
          status: 'streaming',
          startedAt,
          items: runProjection.tools.map((tool) => ({
            id: tool.id,
            name: tool.name,
            status: tool.status,
            startedAt: tool.createdAt,
          })),
        },
      ],
      citations: [],
      attachments: [],
      artifacts: [],
    };
  }, [activeProvider, liveOutputByRun, runProjection, threadEvents]);

  const createSession = async (): Promise<void> => {
    followNextOutput();
    setError(null);
    const expectedSelection = {
      sessionId: selectedSessionRef.current,
      threadId: selectedThreadRef.current,
    };
    try {
      const created = await request<{ session: Session }>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title: newConversationTitle(),
          sourceKey: `web:${crypto.randomUUID()}`,
        }),
      });
      if (
        !selectionIdentityMatches(expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        })
      )
        return;
      setView('conversation');
      setSessionDrawerOpen(false);
      const loaded = await refresh(created.session.id);
      const createdThreadId = selectedThreadRef.current;
      if (!loaded || selectedSessionRef.current !== created.session.id || !createdThreadId) return;
      setNotice('New conversation ready');
      window.setTimeout(() => {
        if (
          selectedSessionRef.current === created.session.id &&
          selectedThreadRef.current === createdThreadId
        )
          composerRef.current?.focus();
      }, 0);
    } catch (cause) {
      if (
        !selectionIdentityMatches(expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        })
      )
        return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createThread = async (): Promise<void> => {
    if (!selectedSessionId) return;
    followNextOutput();
    const sessionId = selectedSessionId;
    const expectedSelection = {
      sessionId,
      threadId: selectedThreadRef.current,
    };
    let createdThreadId: string | null = null;
    let createdThreadLoad: SelectionLoad | null = null;
    setError(null);
    try {
      const created = await request<{ thread: Thread }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/threads`,
        {
          method: 'POST',
          body: JSON.stringify({ title: `Thread ${threads.length + 1}` }),
        },
      );
      createdThreadId = created.thread.id;
      if (
        !selectionIdentityMatches(expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        })
      )
        return;
      const load = beginForegroundLoad({ sessionId, threadId: created.thread.id });
      createdThreadLoad = load;
      const loaded = await loadSession(sessionId, load, created.thread.id);
      if (
        !loaded ||
        selectedSessionRef.current !== sessionId ||
        selectedThreadRef.current !== created.thread.id
      )
        return;
      setNotice('New thread ready');
    } catch (cause) {
      const currentSelection = {
        sessionId: selectedSessionRef.current,
        threadId: selectedThreadRef.current,
      };
      const ownsFailure = createdThreadId
        ? currentSelection.sessionId === sessionId &&
          currentSelection.threadId === createdThreadId &&
          createdThreadLoad !== null &&
          snapshotLoadIsCurrent(selectionLoads.current, createdThreadLoad)
        : selectionIdentityMatches(expectedSelection, currentSelection);
      if (!ownsFailure || isRequestAbort(cause)) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const chooseSession = async (sessionId: string): Promise<void> => {
    followNextOutput();
    const load = beginForegroundLoad({ sessionId, threadId: null });
    clearThreadView();
    setThreads([]);
    setSelectedThreadId(null);
    selectedThreadRef.current = null;
    setSelectedSessionId(sessionId);
    selectedSessionRef.current = sessionId;
    setSessionDrawerOpen(false);
    setView('conversation');
    try {
      const loaded = await loadSession(sessionId, load, null);
      if (!loaded || !snapshotLoadIsCurrent(selectionLoads.current, load)) return;
      setError(null);
    } catch (cause) {
      if (!snapshotLoadIsCurrent(selectionLoads.current, load) || isRequestAbort(cause)) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const chooseThread = async (threadId: string): Promise<void> => {
    const sessionId = selectedSessionRef.current;
    if (!sessionId) return;
    followNextOutput();
    const load = beginForegroundLoad({ sessionId, threadId });
    clearThreadView();
    setSelectedThreadId(threadId);
    selectedThreadRef.current = threadId;
    try {
      const runState = await loadThread(
        threadId,
        load,
        selectionLoads.current,
        { sessionId, threadId },
        true,
      );
      if (!runState || !snapshotLoadIsCurrent(selectionLoads.current, load)) return;
      setEventSubscription({
        sessionId,
        after: runState.lastEventId,
        generation: load.generation,
      });
      setError(null);
    } catch (cause) {
      if (!snapshotLoadIsCurrent(selectionLoads.current, load) || isRequestAbort(cause)) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const executeComposerCommand = async (command: ComposerCommand): Promise<void> => {
    setInput('');
    if (command === 'new-session') await createSession();
    else if (command === 'refresh') {
      if (await refresh(selectedSessionRef.current)) setNotice('Runtime refreshed');
    } else if (command === 'memory') setView('memory');
    else if (command === 'automations') setView('automations');
    else setView('system');
  };

  const send = async (mode: 'next' | 'interrupt' = 'next'): Promise<void> => {
    const value = input.trim();
    const command = resolveComposerCommand(value);
    if (command) {
      await executeComposerCommand(command);
      return;
    }
    if (!value || !selectedThreadId || connection !== 'connected') return;
    const threadId = selectedThreadId;
    const sessionId = selectedSessionRef.current;
    const expectedSelection = { sessionId, threadId };
    const currentRunId = activeRunId;
    followNextOutput();
    setInput('');
    setError(null);
    let runAccepted = false;
    try {
      if (mode === 'interrupt' && currentRunId)
        await request(
          `/api/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(currentRunId)}/cancel`,
          { method: 'POST' },
        );
      const run = await request<{ id: string }>('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ threadId, input: value }),
      });
      runAccepted = true;
      const stillSelected = selectionIdentityMatches(expectedSelection, {
        sessionId: selectedSessionRef.current,
        threadId: selectedThreadRef.current,
      });
      if (currentRunId) {
        setQueuedRunsByThread((current) => ({
          ...current,
          [threadId]: [...new Set([...(current[threadId] ?? []), run.id])],
        }));
        setQueuedPromptsByRun((current) => ({ ...current, [run.id]: value }));
        if (stillSelected)
          setNotice(
            mode === 'interrupt' ? 'Interrupt requested · follow-up queued' : 'Follow-up queued',
          );
      } else setActiveRunsByThread((current) => ({ ...current, [threadId]: run.id }));
      if (sessionId && stillSelected) {
        const load = beginForegroundLoad(expectedSelection);
        await loadThread(threadId, load);
      }
    } catch (cause) {
      if (
        !selectionIdentityMatches(expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        }) ||
        isRequestAbort(cause)
      )
        return;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!runAccepted) setInput(value);
      setError(runAccepted ? `Run accepted, but conversation refresh failed: ${message}` : message);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!activeRunId || !selectedThreadId) return;
    const runId = activeRunId;
    const threadId = selectedThreadId;
    const expectedSelection = { sessionId: selectedSessionRef.current, threadId };
    try {
      await request(
        `/api/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/cancel`,
        { method: 'POST' },
      );
      if (
        selectionIdentityMatches(expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        })
      )
        setNotice('Cancellation requested');
    } catch (cause) {
      if (
        !selectionIdentityMatches(expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        })
      )
        return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const retryRun = async (runId: string): Promise<void> => {
    const threadId = selectedThreadRef.current;
    const sessionId = selectedSessionRef.current;
    if (!threadId || !sessionId || activeRunForThread(activeRunsByThread, threadId)) return;
    const expectedSelection = { sessionId, threadId };
    let retryLoad: SelectionLoad | null = null;
    try {
      const resumed = await request<{ id: string }>(
        `/api/runs/${encodeURIComponent(runId)}/resume`,
        {
          method: 'POST',
        },
      );
      setActiveRunsByThread((current) => ({ ...current, [threadId]: resumed.id }));
      if (
        !selectionIdentityMatches(expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        })
      )
        return;
      const load = beginForegroundLoad(expectedSelection);
      retryLoad = load;
      const runState = await loadThread(threadId, load);
      if (
        !runState ||
        !snapshotCanCommit(selectionLoads.current, load, expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        })
      )
        return;
      setNotice('Retry started');
    } catch (cause) {
      if (
        !selectionIdentityMatches(expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        }) ||
        (retryLoad !== null && !snapshotLoadIsCurrent(selectionLoads.current, retryLoad)) ||
        isRequestAbort(cause)
      )
        return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const loadEarlierMessages = async (): Promise<void> => {
    const threadId = selectedThreadRef.current;
    const sessionId = selectedSessionRef.current;
    const before = historyCursor;
    if (!threadId || !sessionId || before === null || loadingEarlierMessages) return;
    const expectedSelection = { sessionId, threadId };
    const load = beginForegroundLoad(expectedSelection);
    setLoadingEarlierMessages(true);
    try {
      const page = await request<ThreadPresentation>(
        `/api/threads/${encodeURIComponent(threadId)}/presentation?before=${before}&limit=100`,
        { signal: load.signal },
      );
      if (
        !snapshotCanCommit(selectionLoads.current, load, expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        })
      )
        return;
      const scroller = messagesRef.current;
      const previousScrollHeight = scroller?.scrollHeight ?? 0;
      const previousScrollTop = scroller?.scrollTop ?? 0;
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [...page.messages.filter((message) => !known.has(message.id)), ...current];
      });
      setHistoryCursor(page.nextCursor);
      setHasEarlierMessages(page.hasMore);
      const frame = window.requestAnimationFrame(() => {
        if (historyFrameRef.current === frame) historyFrameRef.current = null;
        if (
          !snapshotCanCommit(selectionLoads.current, load, expectedSelection, {
            sessionId: selectedSessionRef.current,
            threadId: selectedThreadRef.current,
          })
        )
          return;
        const currentScroller = messagesRef.current;
        if (!currentScroller) return;
        currentScroller.scrollTop = preserveScrollAnchor({
          previousScrollHeight,
          previousScrollTop,
          nextScrollHeight: currentScroller.scrollHeight,
        });
      });
      historyFrameRef.current = frame;
    } catch (cause) {
      if (
        snapshotCanCommit(selectionLoads.current, load, expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        })
      )
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (
        snapshotCanCommit(selectionLoads.current, load, expectedSelection, {
          sessionId: selectedSessionRef.current,
          threadId: selectedThreadRef.current,
        })
      )
        setLoadingEarlierMessages(false);
    }
  };

  const createSchedule = async (): Promise<void> => {
    if (!scheduleName.trim() || !scheduleInput.trim()) return;
    try {
      await request('/api/schedules', {
        method: 'POST',
        body: JSON.stringify({
          name: scheduleName.trim(),
          type: 'manual',
          expression: '',
          agentInput: scheduleInput.trim(),
        }),
      });
      setScheduleName('');
      setScheduleInput('');
      await loadSystem();
      setNotice('Automation created');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const saveMemory = async (content: string): Promise<void> => {
    setSaveStatus('saving');
    try {
      await request('/api/memory', {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      setSaveStatus('saved');
      await loadSystem();
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (cause) {
      setSaveStatus('error');
      setError(cause instanceof Error ? cause.message : String(cause));
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  const deleteMemory = async (id: string): Promise<void> => {
    try {
      await request(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setMemories((current) => current.filter((m) => m.id !== id));
      setNotice('Memory deleted');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const scheduleAction = async (
    id: string,
    action: 'pause' | 'resume' | 'trigger',
  ): Promise<void> => {
    try {
      await request(`/api/schedules/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      await loadSystem();
      setNotice(action === 'trigger' ? 'Automation started' : `Automation ${action}d`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const deleteSchedule = async (id: string): Promise<void> => {
    try {
      await request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadSystem();
      setNotice('Automation deleted');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const updateSchedule = async (id: string, name: string, agentInput: string): Promise<void> => {
    try {
      await request(`/api/schedules/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ name, agentInput }),
      });
      await loadSystem();
      setNotice('Automation updated');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const switchProvider = async (provider: string, model: string): Promise<void> => {
    setError(null);
    try {
      const result = await request<{ active: ActiveProvider }>('/api/providers/switch', {
        method: 'POST',
        body: JSON.stringify({ provider, model }),
      });
      setActiveProvider(result.active);
      setNotice(`Using ${displayModel(result.active)}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const providerNotice = providerUnavailableNotice(message, provider, activeProvider);
      if (!providerNotice) {
        setError(message);
        return;
      }
      try {
        await loadSystem();
        setNotice(providerNotice);
      } catch (refreshCause) {
        setError(refreshCause instanceof Error ? refreshCause.message : String(refreshCause));
      }
    }
  };

  const unloadPlugin = async (name: string): Promise<void> => {
    try {
      await request(`/api/plugins/${encodeURIComponent(name)}/unload`, { method: 'POST' });
      await loadSystem();
      setNotice(`${name} unloaded`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const enableSkill = async (name: string): Promise<void> => {
    try {
      await request(`/api/skills/${encodeURIComponent(name)}/enable`, { method: 'POST' });
      await loadSystem();
      setNotice(`${name} enabled`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const disableSkill = async (name: string): Promise<void> => {
    try {
      await request(`/api/skills/${encodeURIComponent(name)}/disable`, { method: 'POST' });
      await loadSystem();
      setNotice(`${name} disabled`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const configurePlugin = async (name: string, config: Record<string, unknown>): Promise<void> => {
    try {
      await request(`/api/plugins/${encodeURIComponent(name)}/config`, {
        method: 'POST',
        body: JSON.stringify({ config }),
      });
      await loadSystem();
      setNotice(`${name} configured`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const decideApproval = async (
    id: string,
    payloadHash: string,
    decision: 'approve' | 'deny',
  ): Promise<void> => {
    if (decidingApprovalIdsRef.current.has(id)) return;
    decidingApprovalIdsRef.current.add(id);
    setDecidingApprovalIds(new Set(decidingApprovalIdsRef.current));
    setError(null);
    try {
      await request(`/api/approvals/${encodeURIComponent(id)}/${decision}`, {
        method: 'POST',
        body: JSON.stringify({ payloadHash }),
      });
      setApprovals((current) => current.filter((approval) => approval.id !== id));
      await loadSystem();
      setNotice(decision === 'approve' ? 'Action approved once' : 'Action denied');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      try {
        await loadSystem();
      } catch (refreshCause) {
        setError(
          `${message}. Approval refresh failed: ${refreshCause instanceof Error ? refreshCause.message : String(refreshCause)}`,
        );
        return;
      } finally {
        decidingApprovalIdsRef.current.delete(id);
        setDecidingApprovalIds(new Set(decidingApprovalIdsRef.current));
      }
      setError(message);
      return;
    }
    decidingApprovalIdsRef.current.delete(id);
    setDecidingApprovalIds(new Set(decidingApprovalIdsRef.current));
  };

  const executeCommand = async (id: CommandId): Promise<void> => {
    setCommandPaletteOpen(false);
    if (id === 'new-session') await createSession();
    else if (id === 'new-thread') await createThread();
    else if (id === 'refresh') {
      if (await refresh(selectedSessionRef.current)) setNotice('Runtime refreshed');
    } else if (id === 'focus-composer') {
      setView('conversation');
      window.setTimeout(() => composerRef.current?.focus(), 0);
    } else if (id === 'cancel-run') await cancel();
  };

  return (
    <div className="app-shell" data-connection={connection}>
      <header className="app-header">
        <button
          type="button"
          className="icon-button menu-button"
          aria-label="Open conversations"
          aria-expanded={sessionDrawerOpen}
          onClick={() => setSessionDrawerOpen((open) => !open)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" data-connection={connection}>
            N
          </span>
          <div>
            <strong>NUAAI</strong>
            <small>Local agent</small>
          </div>
        </div>
        <div className="header-actions">
          <div className={`connection connection-${connection}`} aria-live="polite">
            <span aria-hidden="true" />
            {notice ?? connectionLabel(connection)}
          </div>
          <button
            type="button"
            className="header-button command-button"
            onClick={() => setCommandPaletteOpen(true)}
            aria-haspopup="dialog"
          >
            Commands <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            className="icon-button refresh-button"
            aria-label="Refresh runtime"
            onClick={() => void refresh(selectedSessionRef.current)}
          >
            <span aria-hidden="true">↻</span>
          </button>
        </div>
      </header>

      <div className="app-frame">
        <aside
          ref={sessionRailRef}
          className={`session-rail ${sessionDrawerOpen ? 'open' : ''}`}
          aria-label="Conversations"
          aria-modal={sessionDrawerOpen ? true : undefined}
          role={sessionDrawerOpen ? 'dialog' : undefined}
        >
          <div className="rail-heading">
            <button
              type="button"
              className="new-conversation-button"
              onClick={() => void createSession()}
            >
              New conversation
            </button>
            <label className="session-search">
              <span className="sr-only">Search conversations</span>
              <input
                type="search"
                value={sessionSearch}
                placeholder="Search conversations"
                onChange={(event) => setSessionSearch(event.target.value)}
              />
            </label>
          </div>
          <div className="session-list">
            {sessionGroups.length ? (
              sessionGroups.map((group) => (
                <section className="session-group" key={group.label}>
                  <h2>{group.label}</h2>
                  {group.sessions.map((session) => (
                    <button
                      type="button"
                      className={`session-row ${selectedSessionId === session.id ? 'selected' : ''}`}
                      aria-current={selectedSessionId === session.id ? 'page' : undefined}
                      key={session.id}
                      onClick={() => void chooseSession(session.id)}
                    >
                      <span className="session-glyph" aria-hidden="true" />
                      <span>
                        <strong>{session.title}</strong>
                        <small>{selectedSessionId === session.id ? 'Current' : 'Saved'}</small>
                      </span>
                    </button>
                  ))}
                </section>
              ))
            ) : (
              <div className="rail-empty">
                <strong>{sessions.length ? 'No matches' : 'No conversations'}</strong>
                <p>
                  {sessions.length
                    ? 'Try a different conversation search.'
                    : 'Start one to create a durable session.'}
                </p>
              </div>
            )}
          </div>
          <NavigationTabs
            view={view}
            memoryCount={memories.length}
            automationCount={schedules.length}
            onChange={(nextView) => {
              setView(nextView);
              setSessionDrawerOpen(false);
            }}
          />
          <div className="rail-footer">
            <span className={`connection-dot connection-${connection}`} aria-hidden="true" />
            <span>Daemon</span>
            <strong>{connectionLabel(connection)}</strong>
          </div>
        </aside>
        {sessionDrawerOpen && (
          <button
            type="button"
            className="drawer-scrim"
            aria-label="Close conversations"
            onClick={() => setSessionDrawerOpen(false)}
          />
        )}

        <main className="workspace">
          <ApprovalInbox
            approvals={approvals}
            decidingIds={decidingApprovalIds}
            onApprove={(id, payloadHash) => void decideApproval(id, payloadHash, 'approve')}
            onDeny={(id, payloadHash) => void decideApproval(id, payloadHash, 'deny')}
          />
          {view === 'conversation' && (
            <section
              id="view-conversation"
              className="conversation-view"
              role="tabpanel"
              aria-label="Conversation"
            >
              <div className="conversation-pane">
                <div className="conversation-header">
                  <div className="conversation-title">
                    <span className="section-label">
                      {selectedSession?.title ?? 'Conversation'}
                    </span>
                    <div className="thread-control">
                      {threads.length > 1 ? (
                        <select
                          aria-label="Thread"
                          value={selectedThreadId ?? ''}
                          onChange={(event) => void chooseThread(event.target.value)}
                        >
                          {threads.map((item) => (
                            <option value={item.id} key={item.id}>
                              {item.title}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <h1>{selectedThread?.title ?? 'Ready when you are'}</h1>
                      )}
                      {selectedSession && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => void createThread()}
                        >
                          New thread
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div
                  ref={messagesRef}
                  className="messages"
                  aria-live="polite"
                  onScroll={(event) => {
                    const nearBottom = isNearScrollBottom(event.currentTarget);
                    nearBottomRef.current = nearBottom;
                    if (!nearBottom) {
                      if (followFrameRef.current !== null) {
                        window.cancelAnimationFrame(followFrameRef.current);
                        followFrameRef.current = null;
                      }
                      forceFollowRef.current = false;
                      if (
                        shouldShowNewResponseButton({
                          nearBottom,
                          hasLiveResponse: Boolean(liveMessage),
                        })
                      )
                        setShowNewResponse(true);
                    } else setShowNewResponse(false);
                  }}
                >
                  {selectedThread && hasEarlierMessages && (
                    <div className="history-loader">
                      <button
                        type="button"
                        disabled={loadingEarlierMessages}
                        onClick={() => void loadEarlierMessages()}
                      >
                        {loadingEarlierMessages ? 'Loading…' : 'Load earlier messages'}
                      </button>
                    </div>
                  )}
                  {!selectedThread ? (
                    <div className="conversation-empty">
                      <span className="empty-mark" aria-hidden="true">
                        N
                      </span>
                      <h2>Start with a real question</h2>
                      <p>NUAAI keeps the session, run state, and action trail on this machine.</p>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => void createSession()}
                      >
                        Start a conversation
                      </button>
                    </div>
                  ) : transcript.length === 0 && !runProjection?.liveOutput ? (
                    <div className="conversation-empty">
                      <span className="empty-mark" aria-hidden="true">
                        N
                      </span>
                      <h2>What should NUAAI work on?</h2>
                      <p>Ask about the workspace, runtime status, or available capabilities.</p>
                      <div className="starter-actions">
                        {[
                          'Summarize this workspace',
                          'Check the current system status',
                          'Explain the capabilities available in this session',
                        ].map((prompt) => (
                          <button type="button" key={prompt} onClick={() => setInput(prompt)}>
                            {prompt}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="message-stack">
                      {transcript.map((message) => (
                        <article className={`message message-${message.role}`} key={message.id}>
                          <div className="message-meta">
                            <span>{message.role === 'user' ? 'You' : 'NUAAI'}</span>
                            <time>{relativeTime(message.createdAt)}</time>
                          </div>
                          <MarkdownContent markdown={message.markdown} />
                          <ArtifactCards message={message} resolveUrl={appPath} />
                          {message.role === 'assistant' && (
                            <RunStatusSummary
                              message={message}
                              {...(message.runId
                                ? { onRetry: () => void retryRun(message.runId as string) }
                                : {})}
                            />
                          )}
                        </article>
                      ))}
                      {liveMessage && (
                        <article className="message message-assistant message-live">
                          <div className="message-meta">
                            <span>NUAAI</span>
                            <span>{runLabel(runProjection?.status)}</span>
                          </div>
                          <div className="message-live-body">
                            {liveMessage.markdown ? (
                              <MarkdownContent markdown={liveMessage.markdown} />
                            ) : (
                              <p className="response-placeholder">Preparing response…</p>
                            )}
                            <span className="live-cursor" aria-hidden="true" />
                          </div>
                          <RunStatusSummary message={liveMessage} active />
                        </article>
                      )}
                    </div>
                  )}
                </div>
                {showNewResponse && (
                  <button
                    type="button"
                    className="new-response-button"
                    aria-label="Jump to newest response"
                    onClick={scrollToLatest}
                  >
                    New response ↓
                  </button>
                )}

                <AgentComposer
                  input={input}
                  selectedThread={Boolean(selectedThread)}
                  connection={connection}
                  activeRunId={activeRunId}
                  activeProvider={activeProvider}
                  providers={providers}
                  permissionProfile={webPermissionProfile}
                  queuedItems={queuedItems}
                  expanded={composerExpanded}
                  textareaRef={composerRef}
                  onInput={setInput}
                  onExpanded={setComposerExpanded}
                  onSubmit={(mode) => void send(mode)}
                  onStop={() => void cancel()}
                  onSwitchProvider={(provider, model) => void switchProvider(provider, model)}
                  onCommand={(command) => void executeComposerCommand(command)}
                />
              </div>
            </section>
          )}

          {view === 'memory' && (
            <MemoryView
              memories={memories}
              onDelete={deleteMemory}
              saveMemory={saveMemory}
              saveStatus={saveStatus}
            />
          )}

          {view === 'automations' && (
            <AutomationsView
              schedules={schedules}
              tasks={tasks}
              scheduleName={scheduleName}
              scheduleInput={scheduleInput}
              onScheduleName={setScheduleName}
              onScheduleInput={setScheduleInput}
              onCreate={() => void createSchedule()}
              onAction={(id, action) => void scheduleAction(id, action)}
              onDelete={deleteSchedule}
              onUpdate={updateSchedule}
            />
          )}

          {view === 'system' && (
            <SystemView
              connection={connection}
              activeProvider={activeProvider}
              providers={providers}
              skills={skills}
              plugins={plugins}
              pluginHealth={pluginHealth}
              onSwitchProvider={(provider, model) => void switchProvider(provider, model)}
              onUnloadPlugin={(name) => void unloadPlugin(name)}
              onEnableSkill={enableSkill}
              onDisableSkill={disableSkill}
              onConfigurePlugin={configurePlugin}
            />
          )}
        </main>
      </div>

      <NavigationTabs
        mobile
        view={view}
        memoryCount={memories.length}
        automationCount={schedules.length}
        onChange={(nextView) => {
          setView(nextView);
          setSessionDrawerOpen(false);
        }}
      />

      {error && (
        <ErrorToast
          title={authenticationError ? 'Pair this device' : undefined}
          error={error}
          onRetry={authenticationError ? undefined : () => void refresh(selectedSessionRef.current)}
          onDismiss={() => setError(null)}
        />
      )}

      {commandPaletteOpen && (
        <CommandPalette
          activeRunId={activeRunId}
          selectedSessionId={selectedSessionId}
          firstActionRef={paletteFirstActionRef}
          onExecute={(id) => void executeCommand(id)}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(appPath('/sw.js'));
  });
}
