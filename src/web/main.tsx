import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

interface Session {
  id: string;
  title: string;
  status: string;
}
interface Thread {
  id: string;
  title: string;
}
interface Message {
  role: string;
  content: string;
  createdAt: number;
}
interface EventRecord {
  id?: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}
interface Schedule {
  id: string;
  name: string;
  type: string;
  expression: string;
  agentInput: string;
  enabled: boolean;
  nextRunAt: number | null;
  policy: {
    missedRun: string;
    maxAttempts: number;
    retryDelayMs: number;
    concurrencyLimit: number;
  };
}
interface Task {
  id: string;
  kind: string;
  status: string;
  scheduleId: string | null;
  payload: Record<string, unknown>;
  updatedAt: number;
}
interface MemoryRecord {
  id: string;
  content: string;
  createdAt: number;
  hasEmbedding: boolean;
}
interface SkillRecord {
  name: string;
  description: string;
  version: string;
  source: string;
}
interface PluginRecord {
  name: string;
  version: string;
  apiVersion: string;
  capabilities: string[];
  trusted: boolean;
}
interface PluginHealth {
  name: string;
  loaded: boolean;
  enabled: boolean;
  capabilities: string[];
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}

function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<Session | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [input, setInput] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [status, setStatus] = useState('Connecting');
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<
    Array<{ name: string; available: boolean; detail: string }>
  >([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scheduleName, setScheduleName] = useState('');
  const [scheduleInput, setScheduleInput] = useState('');
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [pluginHealth, setPluginHealth] = useState<PluginHealth[]>([]);
  const [view, setView] = useState<'conversation' | 'memory' | 'skills' | 'plugins' | 'schedules'>(
    'conversation',
  );
  const loadRequest = useRef(0);

  const load = useCallback(
    async (preferredSessionId?: string): Promise<void> => {
      const requestId = ++loadRequest.current;
      const isCurrent = (): boolean => requestId === loadRequest.current;
      try {
        const result = await request<{ sessions: Session[] }>('/api/sessions');
        if (!isCurrent()) return;
        setSessions(result.sessions);
        const preferred = preferredSessionId
          ? result.sessions.find((session) => session.id === preferredSessionId)
          : null;
        const active =
          preferred ??
          (selected && result.sessions.find((session) => session.id === selected.id)
            ? selected
            : (result.sessions[0] ?? null));
        if (active) {
          setSelected(active);
          const detail = await request<{ threads: Thread[] }>(`/api/sessions/${active.id}`);
          if (!isCurrent()) return;
          const nextThread = detail.threads[0] ?? null;
          setThread(nextThread);
          if (nextThread) {
            const messageResult = await request<{ messages: Message[] }>(
              `/api/threads/${nextThread.id}/messages`,
            );
            if (!isCurrent()) return;
            setMessages(messageResult.messages);
          }
          const eventResult = await request<{ events: EventRecord[] }>(
            `/api/events?after=0&sessionId=${encodeURIComponent(active.id)}`,
          );
          if (!isCurrent()) return;
          setEvents(eventResult.events.slice(-100));
        } else {
          setEvents([]);
        }
        const [
          providerResult,
          scheduleResult,
          taskResult,
          memoryResult,
          skillResult,
          pluginResult,
        ] = await Promise.all([
          request<{ providers: Array<{ name: string; available: boolean; detail: string }> }>(
            '/api/providers',
          ),
          request<{ schedules: Schedule[] }>('/api/schedules'),
          request<{ tasks: Task[] }>('/api/tasks'),
          request<{ memories: MemoryRecord[] }>('/api/memory'),
          request<{ skills: SkillRecord[] }>('/api/skills'),
          request<{ plugins: PluginRecord[]; health: PluginHealth[] }>('/api/plugins'),
        ]);
        if (!isCurrent()) return;
        setProviders(providerResult.providers);
        setSchedules(scheduleResult.schedules);
        setTasks(taskResult.tasks);
        setMemories(memoryResult.memories);
        setSkills(skillResult.skills);
        setPlugins(pluginResult.plugins);
        setPluginHealth(pluginResult.health);
        setStatus('Connected');
      } catch (cause) {
        if (!isCurrent()) return;
        setStatus('Daemon unavailable');
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [selected],
  );
  useEffect(() => {
    void load();
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socket.onopen = () => {
      setEvents([]);
      socket.send(JSON.stringify({ type: 'subscribe', sessionId: selected?.id, after: 0 }));
      setStatus('Connected');
    };
    socket.onmessage = (message) => {
      const value = JSON.parse(String(message.data)) as { type: string; event?: EventRecord };
      if (value.type === 'event' && value.event) {
        setEvents((current) => [...current.slice(-99), value.event as EventRecord]);
        if (['run.completed', 'run.failed', 'run.cancelled'].includes(value.event.type))
          void load();
      }
    };
    socket.onerror = () => setStatus('WebSocket unavailable');
    return () => socket.close();
  }, [load, selected?.id]);
  const liveOutput = useMemo(
    () =>
      events
        .filter((event) => event.type === 'model.delta')
        .map((event) => String(event.payload.text ?? ''))
        .join(''),
    [events],
  );
  const createSession = async (): Promise<void> => {
    const created = await request<{ session: Session }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: `Session ${sessions.length + 1}` }),
    });
    setSelected(created.session);
    await load(created.session.id);
  };
  const send = async (): Promise<void> => {
    if (!input.trim() || !thread) return;
    const value = input.trim();
    setInput('');
    setError(null);
    const started = await request<{ id: string }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ threadId: thread.id, input: value }),
    });
    setActiveRunId(started.id);
    try {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const run = await request<{ status: string }>(`/api/runs/${started.id}`);
        if (['completed', 'failed', 'cancelled'].includes(run.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      setActiveRunId(null);
    }
    await load(selected?.id);
  };
  const cancel = async (): Promise<void> => {
    if (!activeRunId) return;
    await request(`/api/runs/${activeRunId}/cancel`, { method: 'POST' });
  };
  const createSchedule = async (): Promise<void> => {
    if (!scheduleName.trim() || !scheduleInput.trim()) return;
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
    await load(selected?.id);
  };
  const scheduleAction = async (
    id: string,
    action: 'pause' | 'resume' | 'trigger',
  ): Promise<void> => {
    await request(`/api/schedules/${id}/${action}`, { method: 'POST' });
    await load(selected?.id);
  };
  const unloadPlugin = async (name: string): Promise<void> => {
    await request(`/api/plugins/${encodeURIComponent(name)}/unload`, { method: 'POST' });
    await load(selected?.id);
  };
  const toolEvents = events.filter((event) =>
    ['tool.started', 'tool.completed', 'tool.failed'].includes(event.type),
  );

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <span className="eyebrow">LOCAL AGENT SYSTEM</span>
          <h1>NUAI</h1>
          <p>not ur avg ai</p>
        </div>
        <div className="status">
          <span className={status === 'Connected' ? 'dot live' : 'dot'} />
          {status}
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <button type="button" className="new-session" onClick={() => void createSession()}>
            + New session
          </button>
          <h2>Sessions</h2>
          {sessions.length ? (
            sessions.map((session) => (
              <button
                type="button"
                className={`session ${selected?.id === session.id ? 'selected' : ''}`}
                key={session.id}
                onClick={() => {
                  setSelected(session);
                  void load();
                }}
              >
                <strong>{session.title}</strong>
                <small>{session.status}</small>
              </button>
            ))
          ) : (
            <div className="empty">No sessions yet.</div>
          )}
          <div className="sidebar-footer">
            <span>Provider health</span>
            {providers.map((provider) => (
              <div className="provider" key={provider.name}>
                <span className={provider.available ? 'dot live' : 'dot'} />
                {provider.name}
                <small>{provider.available ? 'ready' : 'offline'}</small>
              </div>
            ))}
          </div>
        </aside>
        <main className="main">
          <nav className="tabs">
            {(['conversation', 'memory', 'skills', 'plugins', 'schedules'] as const).map((tab) => (
              <button
                type="button"
                className={view === tab ? 'active' : ''}
                key={tab}
                onClick={() => setView(tab)}
              >
                {tab}
                <small>
                  {tab === 'memory'
                    ? memories.length
                    : tab === 'skills'
                      ? skills.length
                      : tab === 'plugins'
                        ? plugins.length
                        : tab === 'schedules'
                          ? schedules.length
                          : ''}
                </small>
              </button>
            ))}
          </nav>
          {view === 'conversation' ? (
            <>
              <section className="panel conversation">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">ACTIVE THREAD</span>
                    <h2>{thread?.title ?? 'No thread selected'}</h2>
                  </div>
                  <span className="chip">persistent</span>
                </div>
                <div className="messages">
                  {messages.length ? (
                    messages.map((message, index) => (
                      <article
                        className={`message ${message.role}`}
                        key={`${message.createdAt}-${index}`}
                      >
                        <span className="role">{message.role}</span>
                        <p>{message.content}</p>
                      </article>
                    ))
                  ) : (
                    <div className="empty large">
                      Create a session and send a message to start the agent.
                    </div>
                  )}
                  {liveOutput && (
                    <article className="message assistant live-message">
                      <span className="role">assistant · live</span>
                      <p>
                        {liveOutput}
                        <span className="cursor" />
                      </p>
                    </article>
                  )}
                </div>
                {toolEvents.length > 0 && (
                  <div className="tool-activity" aria-label="Tool activity">
                    <span className="eyebrow">TOOL ACTIVITY</span>
                    {toolEvents.slice(-8).map((event, index) => (
                      <div key={`${event.createdAt}-${index}`}>
                        {event.type} · {String(event.payload.name ?? 'tool')}
                      </div>
                    ))}
                  </div>
                )}
                <div className="composer">
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    placeholder="Ask NUAI anything…"
                    disabled={!thread}
                  />
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={!thread || !input.trim()}
                  >
                    Send ↗
                  </button>
                  {activeRunId && (
                    <button type="button" onClick={() => void cancel()}>
                      Cancel run
                    </button>
                  )}
                </div>
              </section>
              <section className="stats">
                <div>
                  <span>Sessions</span>
                  <strong>{sessions.length}</strong>
                </div>
                <div>
                  <span>Events</span>
                  <strong>{events.length}</strong>
                </div>
                <div>
                  <span>Memory records</span>
                  <strong>{memories.length}</strong>
                </div>
                <div>
                  <span>Background schedules</span>
                  <strong>{schedules.length}</strong>
                </div>
              </section>
            </>
          ) : (
            <section className="panel secondary">
              <span className="eyebrow">SYSTEM SURFACE</span>
              <h2>{view[0].toUpperCase() + view.slice(1)}</h2>
              {view === 'memory' && (
                <div className="record-list" aria-label="Memory records">
                  {memories.length === 0 && <div className="empty">No memory records yet.</div>}
                  {memories.map((memory) => (
                    <article className="record" key={memory.id}>
                      <strong>{memory.content}</strong>
                      <small>
                        {memory.hasEmbedding ? 'semantic index ready' : 'embedding unavailable'}
                      </small>
                    </article>
                  ))}
                </div>
              )}
              {view === 'skills' && (
                <div className="record-list" aria-label="Skills">
                  {skills.length === 0 && <div className="empty">No skills registered.</div>}
                  {skills.map((skill) => (
                    <article className="record" key={skill.name}>
                      <strong>{skill.name}</strong>
                      <small>
                        {skill.version} · {skill.source}
                      </small>
                      <p>{skill.description}</p>
                    </article>
                  ))}
                </div>
              )}
              {view === 'plugins' && (
                <div className="record-list" aria-label="Plugins">
                  {plugins.length === 0 && <div className="empty">No trusted plugins loaded.</div>}
                  {plugins.map((plugin) => {
                    const health = pluginHealth.find((entry) => entry.name === plugin.name);
                    return (
                      <article className="record" key={plugin.name}>
                        <strong>{plugin.name}</strong>
                        <small>
                          {plugin.version} · API {plugin.apiVersion} ·{' '}
                          {health?.enabled ? 'enabled' : 'disabled'}
                        </small>
                        <p>Capabilities: {plugin.capabilities.join(', ') || 'none'}</p>
                        <button type="button" onClick={() => void unloadPlugin(plugin.name)}>
                          Unload
                        </button>
                      </article>
                    );
                  })}
                </div>
              )}
              {view === 'schedules' && (
                <div className="schedule-manager">
                  <p>
                    {schedules.filter((schedule) => schedule.enabled).length} schedules enabled.
                  </p>
                  <div className="schedule-form">
                    <input
                      aria-label="Schedule name"
                      value={scheduleName}
                      onChange={(event) => setScheduleName(event.target.value)}
                      placeholder="Schedule name"
                    />
                    <input
                      aria-label="Schedule agent input"
                      value={scheduleInput}
                      onChange={(event) => setScheduleInput(event.target.value)}
                      placeholder="Agent instruction"
                    />
                    <button type="button" onClick={() => void createSchedule()}>
                      Create manual schedule
                    </button>
                  </div>
                  <div className="schedule-list">
                    {schedules.length === 0 && <div className="empty">No schedules yet.</div>}
                    {schedules.map((schedule) => {
                      const scheduleTasks = tasks.filter((task) => task.scheduleId === schedule.id);
                      return (
                        <article className="schedule-card" key={schedule.id}>
                          <div>
                            <strong>{schedule.name}</strong>
                            <small>
                              {schedule.type} · {schedule.enabled ? 'enabled' : 'paused'} · attempts{' '}
                              {schedule.policy.maxAttempts}
                            </small>
                            <p>{schedule.agentInput}</p>
                          </div>
                          <div className="schedule-actions">
                            <button
                              type="button"
                              onClick={() => void scheduleAction(schedule.id, 'trigger')}
                            >
                              Trigger
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void scheduleAction(
                                  schedule.id,
                                  schedule.enabled ? 'pause' : 'resume',
                                )
                              }
                            >
                              {schedule.enabled ? 'Pause' : 'Resume'}
                            </button>
                          </div>
                          <small>
                            Recent tasks:{' '}
                            {scheduleTasks
                              .slice(0, 3)
                              .map((task) => task.status)
                              .join(', ') || 'none'}
                          </small>
                        </article>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>
          )}
          {error && <div className="error">{error}</div>}
        </main>
      </div>
    </div>
  );
}

const root = document.querySelector<HTMLDivElement>('#root');
if (!root) throw new Error('NUAI web root is missing');
createRoot(root).render(<App />);
