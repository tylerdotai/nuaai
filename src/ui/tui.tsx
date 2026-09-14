import { randomUUID } from 'node:crypto';
import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { WebSocket } from 'ws';

import { parseScheduleCommand } from './tui-schedule.js';
import {
  type TuiConversationMessage,
  type TuiEvent,
  type TuiView,
  initialTuiState,
  nextSelection,
  reduceTuiEvent,
  tuiMessagesFromPresentation,
} from './tui-state.js';

interface TuiProps {
  baseUrl: string;
  token: string;
}
interface Session {
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
    return { type: 'tool.started', runId, name: payload.name };
  if (value.type === 'tool.completed' && runId && typeof payload.name === 'string')
    return { type: 'tool.completed', runId, name: payload.name };
  if (value.type === 'tool.failed' && runId && typeof payload.name === 'string')
    return { type: 'tool.failed', runId, name: payload.name };
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

async function loadConversationMessages(
  baseUrl: string,
  token: string,
  threadId: string,
): Promise<TuiConversationMessage[]> {
  const presentation = await request<{
    messages: Array<{ role: string; markdown: string }>;
  }>(baseUrl, token, `/api/threads/${threadId}/presentation`);
  return tuiMessagesFromPresentation(presentation.messages);
}

async function loadCatalog(baseUrl: string, token: string): Promise<TuiEvent> {
  const [tasks, schedules, memories, skills, plugins, providers, secrets] = await Promise.all([
    request<{
      tasks: Array<{ id: string; status: string; kind: string; scheduleId: string | null }>;
    }>(baseUrl, token, '/api/tasks'),
    request<{
      schedules: Array<{
        id: string;
        name: string;
        type: string;
        expression: string;
        agentInput: string;
        enabled: boolean;
        nextRunAt: number | null;
      }>;
    }>(baseUrl, token, '/api/schedules'),
    request<{
      memories: Array<{ id: string; content: string; hasEmbedding: boolean }>;
    }>(baseUrl, token, '/api/memory'),
    request<{
      skills: Array<{ name: string; description: string; source?: string }>;
    }>(baseUrl, token, '/api/skills'),
    request<{
      plugins: Array<{ name: string; version: string; capabilities: string[] }>;
      health: Array<{ name: string; enabled: boolean }>;
    }>(baseUrl, token, '/api/plugins'),
    request<{
      providers: Array<{ name: string; available: boolean; detail: string; models?: string[] }>;
      active: { name: string; model: string };
    }>(baseUrl, token, '/api/providers'),
    request<{ names: string[] }>(baseUrl, token, '/api/secrets'),
  ]);

  return {
    type: 'catalog.loaded',
    active: providers.active,
    tasks: tasks.tasks,
    schedules: schedules.schedules,
    memories: memories.memories,
    skills: skills.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source ?? 'daemon',
    })),
    plugins: plugins.plugins.map((plugin) => ({
      ...plugin,
      enabled: plugins.health.find((health) => health.name === plugin.name)?.enabled ?? false,
    })),
    providers: providers.providers,
    secretNames: secrets.names,
  };
}

export function Tui({ baseUrl, token }: TuiProps): React.JSX.Element {
  const { exit } = useApp();
  const [tuiState, dispatch] = useReducer(reduceTuiEvent, initialTuiState);
  const { sessions, threads, stream } = tuiState;
  const selectedSessionRef = useRef<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<TuiConversationMessage[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [scheduleMode, setScheduleMode] = useState<'create' | 'edit' | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await request<{ sessions: Session[] }>(baseUrl, token, '/api/sessions');
      dispatch({ type: 'sessions.loaded', sessions: result.sessions, threads: [] });
      let session =
        result.sessions.find((entry) => entry.id === selectedSessionRef.current) ??
        result.sessions[0];
      if (!session) {
        const created = await request<{ session: Session; thread: Thread }>(
          baseUrl,
          token,
          '/api/sessions',
          {
            method: 'POST',
            body: JSON.stringify({ title: 'Main session', sourceKey: `tui:${randomUUID()}` }),
          },
        );
        session = created.session;
        selectedSessionRef.current = session.id;
        setThread(created.thread);
        dispatch({
          type: 'sessions.loaded',
          sessions: [created.session],
          threads: [{ ...created.thread, sessionId: created.session.id }],
        });
      } else {
        const detail = await request<{ threads: Thread[] }>(
          baseUrl,
          token,
          `/api/sessions/${session.id}`,
        );
        const nextThread = detail.threads[0] ?? null;
        setThread(nextThread);
        dispatch({
          type: 'sessions.loaded',
          sessions: result.sessions,
          threads: detail.threads.map((value) => ({ ...value, sessionId: session.id })),
        });
        if (nextThread) setMessages(await loadConversationMessages(baseUrl, token, nextThread.id));
      }
      selectedSessionRef.current = session.id;
      dispatch(await loadCatalog(baseUrl, token));
      setStatus(`Connected · ${session.title}`);
      dispatch({ type: 'connection.changed', status: 'connected' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setStatus('Disconnected');
      dispatch({ type: 'connection.changed', status: 'disconnected', error: message });
    }
  }, [baseUrl, token]);

  const selectSession = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        selectedSessionRef.current = sessionId;
        const detail = await request<{ threads: Thread[] }>(
          baseUrl,
          token,
          `/api/sessions/${sessionId}`,
        );
        const hydratedThreads = detail.threads.map((value) => ({
          ...value,
          sessionId,
        }));
        dispatch({ type: 'sessions.loaded', sessions, threads: hydratedThreads });
        dispatch({ type: 'session.selected', sessionId });
        const nextThread = detail.threads[0] ?? null;
        setThread(nextThread);
        setMessages(
          nextThread ? await loadConversationMessages(baseUrl, token, nextThread.id) : [],
        );
        setStatus(
          `Connected · ${sessions.find((entry) => entry.id === sessionId)?.title ?? sessionId}`,
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [baseUrl, sessions, token],
  );

  const selectThread = useCallback(
    async (threadId: string): Promise<void> => {
      try {
        const selected = threads.find((entry) => entry.id === threadId);
        if (!selected) return;
        const messages = await loadConversationMessages(baseUrl, token, threadId);
        setThread({ id: selected.id, title: selected.title });
        setMessages(messages);
        dispatch({ type: 'thread.selected', threadId });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [baseUrl, threads, token],
  );

  const providerChoices = tuiState.providers.filter((provider) => provider.available);
  const providerName =
    selectedProvider ?? tuiState.provider?.name ?? providerChoices[0]?.name ?? null;
  const provider = tuiState.providers.find((entry) => entry.name === providerName);
  const modelName =
    selectedModel ??
    (providerName === tuiState.provider?.name ? tuiState.provider.model : null) ??
    provider?.models?.[0] ??
    null;

  useEffect(() => {
    void refresh();
    const socket = new WebSocket(
      `${baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`,
    );
    socket.onopen = () => {
      setStatus('Connected');
      dispatch({ type: 'connection.changed', status: 'connected' });
    };
    socket.onmessage = (event) => {
      const value = JSON.parse(String(event.data)) as {
        type: string;
        event?: {
          type: string;
          runId?: string;
          taskId?: string;
          payload?: Record<string, unknown>;
        };
      };
      if (value.type !== 'event' || !value.event) return;
      const tuiEvent = toTuiEvent(value.event);
      if (tuiEvent) dispatch(tuiEvent);
      if (value.event.type === 'run.completed') void refresh();
    };
    socket.onerror = () => {
      setStatus('WebSocket error');
      dispatch({ type: 'connection.changed', status: 'disconnected', error: 'WebSocket error' });
    };
    return () => socket.close();
  }, [baseUrl, refresh, token]);
  useInput(
    (character, key) => {
      if (key.escape || (key.ctrl && character === 'c')) {
        exit();
        return;
      }
      if (key.ctrl && (key.upArrow || key.downArrow)) {
        const direction: -1 | 1 = key.downArrow ? 1 : -1;
        const nextSessionId = nextSelection(
          tuiState.selectedSessionId,
          sessions.map((session) => session.id),
          direction,
        );
        if (nextSessionId) void selectSession(nextSessionId);
        return;
      }
      if (key.ctrl && (key.leftArrow || key.rightArrow)) {
        const sessionThreads = threads.filter(
          (threadEntry) => threadEntry.sessionId === tuiState.selectedSessionId,
        );
        const direction: -1 | 1 = key.rightArrow ? 1 : -1;
        const nextThreadId = nextSelection(
          tuiState.selectedThreadId,
          sessionThreads.map((threadEntry) => threadEntry.id),
          direction,
        );
        if (nextThreadId) void selectThread(nextThreadId);
        return;
      }
      const viewShortcuts: Record<string, TuiView> = {
        '1': 'conversation',
        '2': 'tasks',
        '3': 'schedules',
        '4': 'memory',
        '5': 'skills',
        '6': 'plugins',
        '7': 'settings',
        '8': 'help',
        '0': 'palette',
      };
      if (key.ctrl && character && viewShortcuts[character]) {
        dispatch({ type: 'view.changed', view: viewShortcuts[character] });
        return;
      }
      if (key.ctrl && character === 'p' && providerChoices.length > 0) {
        const index = providerChoices.findIndex((entry) => entry.name === providerName);
        const next = providerChoices[(index + 1) % providerChoices.length];
        setSelectedProvider(next.name);
        setSelectedModel(next.models?.[0] ?? null);
        if (next.models?.[0])
          void request(baseUrl, token, '/api/providers/switch', {
            method: 'POST',
            body: JSON.stringify({ provider: next.name, model: next.models[0] }),
          })
            .then(() => refresh())
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        dispatch({ type: 'view.changed', view: 'settings' });
        return;
      }
      if (key.ctrl && character === 'm' && provider?.models?.length) {
        const index = provider.models.indexOf(modelName ?? '');
        const nextModel = provider.models[(index + 1) % provider.models.length];
        setSelectedModel(nextModel);
        void request(baseUrl, token, '/api/providers/switch', {
          method: 'POST',
          body: JSON.stringify({ provider: provider.name, model: nextModel }),
        })
          .then(() => refresh())
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        dispatch({ type: 'view.changed', view: 'settings' });
        return;
      }
      if (key.ctrl && character === 'r') {
        void refresh();
        return;
      }
      if (key.ctrl && character === 'n' && tuiState.view === 'schedules') {
        setScheduleMode('create');
        setInput('');
        setError(null);
        return;
      }
      if (key.ctrl && key.shift && character === 'e' && tuiState.view === 'schedules') {
        const schedule = tuiState.schedules[0];
        if (schedule) {
          setScheduleMode('edit');
          setInput(
            `${schedule.id}|${schedule.name}|${schedule.type ?? 'manual'}|${schedule.expression ?? ''}|${schedule.agentInput ?? ''}`,
          );
          setError(null);
        }
        return;
      }
      if (key.ctrl && character === 'g' && tuiState.view === 'schedules') {
        const schedule = tuiState.schedules[0];
        if (schedule)
          void request(baseUrl, token, `/api/schedules/${schedule.id}/trigger`, { method: 'POST' })
            .then(() => refresh())
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        return;
      }
      if (key.ctrl && character === 'e' && tuiState.view === 'schedules') {
        const schedule = tuiState.schedules[0];
        if (schedule) {
          const action = schedule.enabled ? 'pause' : 'resume';
          void request(baseUrl, token, `/api/schedules/${schedule.id}/${action}`, {
            method: 'POST',
          })
            .then(() => refresh())
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        }
        return;
      }
      if (key.ctrl && character === 'x') {
        if (tuiState.activeRunId) {
          void request(baseUrl, token, `/api/runs/${tuiState.activeRunId}/cancel`, {
            method: 'POST',
          }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        } else if (tuiState.view === 'tasks') {
          const task = tuiState.tasks.find((entry) => ['queued', 'running'].includes(entry.status));
          if (task)
            void request(baseUrl, token, `/api/tasks/${task.id}/cancel`, { method: 'POST' })
              .then(() => refresh())
              .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        }
        return;
      }
      if (key.return) {
        if (scheduleMode && tuiState.view === 'schedules') {
          try {
            const draft = parseScheduleCommand(input, scheduleMode);
            const path =
              scheduleMode === 'create' ? '/api/schedules' : `/api/schedules/${draft.id}`;
            const { id: _id, ...body } = draft;
            void request(baseUrl, token, path, {
              method: scheduleMode === 'create' ? 'POST' : 'PUT',
              body: JSON.stringify(body),
            })
              .then(() => {
                setScheduleMode(null);
                setInput('');
                return refresh();
              })
              .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
          return;
        }
        if (tuiState.view !== 'conversation') return;
        const value = input.trim();
        if (!value || !thread) return;
        setInput('');
        void request(baseUrl, token, '/api/runs', {
          method: 'POST',
          body: JSON.stringify({
            threadId: thread.id,
            input: value,
            ...(providerName ? { provider: providerName } : {}),
            ...(modelName ? { model: modelName } : {}),
          }),
        }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        return;
      }
      if (key.backspace || key.delete) setInput((value) => value.slice(0, -1));
      else if (
        !key.ctrl &&
        !key.meta &&
        character &&
        (tuiState.view === 'conversation' || (scheduleMode && tuiState.view === 'schedules'))
      )
        setInput((value) => `${value}${character}`);
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  const renderPanel = (): React.JSX.Element => {
    if (tuiState.view === 'conversation')
      return (
        <Box flexDirection="column">
          <Text color="magenta">Conversation · {thread?.title ?? 'No thread selected'}</Text>
          {messages.slice(-8).map((message, index) => (
            <Text key={`${message.role}-${index}`}>
              <Text bold>{message.role}:</Text> {message.content}
            </Text>
          ))}
          {tuiState.tools.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="blue">Tool activity</Text>
              {tuiState.tools.map((tool, index) => (
                <Text key={`${tool.name}-${index}`}>
                  • {tool.name} [{tool.status}]
                </Text>
              ))}
            </Box>
          )}
          {stream && (
            <Text>
              <Text bold>assistant:</Text> {stream}
            </Text>
          )}
          <Box marginTop={1}>
            <Text color="green">› </Text>
            <Text>{input}</Text>
            <Text color="gray">▌</Text>
          </Box>
        </Box>
      );
    if (tuiState.view === 'tasks')
      return (
        <Box flexDirection="column">
          <Text color="yellow">Background tasks ({tuiState.tasks.length})</Text>
          {tuiState.tasks.length === 0 && <Text dimColor>No background tasks.</Text>}
          {tuiState.tasks.map((task) => (
            <Text key={task.id}>
              • {task.id} · {task.kind} · {task.status}
              {task.scheduleId ? ` · schedule ${task.scheduleId}` : ''}
            </Text>
          ))}
        </Box>
      );
    if (tuiState.view === 'schedules')
      return (
        <Box flexDirection="column">
          <Text color="yellow">Schedules ({tuiState.schedules.length})</Text>
          {tuiState.schedules.length === 0 && <Text dimColor>No schedules configured.</Text>}
          {tuiState.schedules.map((schedule) => (
            <Text key={schedule.id}>
              • {schedule.name} · {schedule.enabled ? 'enabled' : 'paused'} · next{' '}
              {schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : 'manual'}
            </Text>
          ))}
          {scheduleMode && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="green">
                {scheduleMode === 'create' ? 'Create' : 'Edit'} schedule ·{' '}
                {scheduleMode === 'create'
                  ? 'name|type|expression|agent input'
                  : 'id|name|type|expression|agent input'}
              </Text>
              <Text>› {input}▌</Text>
            </Box>
          )}
          <Text dimColor>
            Ctrl-N create · Ctrl-Shift-E edit · Ctrl-G trigger · Ctrl-E pause/resume
          </Text>
        </Box>
      );
    if (tuiState.view === 'memory')
      return (
        <Box flexDirection="column">
          <Text color="yellow">Memory ({tuiState.memories.length})</Text>
          {tuiState.memories.length === 0 && <Text dimColor>No memory records.</Text>}
          {tuiState.memories.slice(0, 20).map((memory) => (
            <Text key={memory.id}>
              • {memory.content} [{memory.hasEmbedding ? 'vector indexed' : 'no embedding'}]
            </Text>
          ))}
        </Box>
      );
    if (tuiState.view === 'skills')
      return (
        <Box flexDirection="column">
          <Text color="yellow">Skills ({tuiState.skills.length})</Text>
          {tuiState.skills.length === 0 && <Text dimColor>No skills registered.</Text>}
          {tuiState.skills.map((skill) => (
            <Text key={skill.name}>
              • {skill.name} · {skill.source} · {skill.description}
            </Text>
          ))}
        </Box>
      );
    if (tuiState.view === 'plugins')
      return (
        <Box flexDirection="column">
          <Text color="yellow">Plugins ({tuiState.plugins.length})</Text>
          {tuiState.plugins.length === 0 && <Text dimColor>No trusted plugins loaded.</Text>}
          {tuiState.plugins.map((plugin) => (
            <Text key={plugin.name}>
              • {plugin.name} v{plugin.version} · {plugin.enabled ? 'enabled' : 'disabled'} ·{' '}
              {plugin.capabilities.join(', ') || 'no capabilities'}
            </Text>
          ))}
        </Box>
      );
    if (tuiState.view === 'settings')
      return (
        <Box flexDirection="column">
          <Text color="yellow">Settings and provider health</Text>
          <Text>
            Selected provider/model: {providerName ?? 'daemon default'} /{' '}
            {modelName ?? 'daemon default'}
          </Text>
          {tuiState.providers.map((entry) => (
            <Text key={entry.name} color={entry.name === providerName ? 'green' : undefined}>
              • {entry.name} · {entry.available ? 'ready' : 'offline'} ·{' '}
              {entry.models?.join(', ') || entry.detail}
            </Text>
          ))}
          <Text>Configured secret names: {tuiState.secretNames.join(', ') || 'none'}</Text>
          <Text dimColor>Ctrl-P cycles providers · Ctrl-M cycles models.</Text>
        </Box>
      );
    if (tuiState.view === 'palette')
      return (
        <Box flexDirection="column">
          <Text color="yellow">Command palette</Text>
          <Text>Ctrl-1 conversation · Ctrl-2 tasks · Ctrl-3 schedules</Text>
          <Text>Ctrl-4 memory · Ctrl-5 skills · Ctrl-6 plugins</Text>
          <Text>Ctrl-7 settings · Ctrl-8 help · Ctrl-R refresh</Text>
          <Text>Ctrl-P provider · Ctrl-M model · Ctrl-X cancel run</Text>
        </Box>
      );
    return (
      <Box flexDirection="column">
        <Text color="yellow">NUAAI help</Text>
        <Text>Ctrl-1..8 navigate surfaces · Ctrl-0 command palette</Text>
        <Text>Enter sends a message · Ctrl-X cancels the active run</Text>
        <Text>Esc exits · Ctrl-R refreshes daemon state</Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>
        NUAAI — not ur avg ai
      </Text>
      <Text dimColor>
        {status} · {tuiState.view} · Esc exit · Ctrl-0 palette · Ctrl-X cancel
        {tuiState.provider ? ` · ${tuiState.provider.name}/${tuiState.provider.model}` : ''}
      </Text>
      {tuiState.retry && (
        <Text color="yellow">
          Retrying task {tuiState.retry.taskId} ({tuiState.retry.attempt}/
          {tuiState.retry.maxAttempts})
        </Text>
      )}
      {error && <Text color="red">Error: {error}</Text>}
      <Box flexDirection="column" marginTop={1}>
        <Text color="green">Sessions</Text>
        {sessions.map((session) => (
          <Text
            key={session.id}
            color={session.id === tuiState.selectedSessionId ? 'green' : undefined}
          >
            • {session.title} [{session.status}]
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color="blue">Threads</Text>
        {tuiState.threads
          .filter((threadEntry) => threadEntry.sessionId === tuiState.selectedSessionId)
          .map((threadEntry) => (
            <Text
              key={threadEntry.id}
              color={threadEntry.id === tuiState.selectedThreadId ? 'green' : undefined}
            >
              • {threadEntry.title}
            </Text>
          ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {renderPanel()}
      </Box>
    </Box>
  );
}
