import { useState } from 'react';
import type { RefObject } from 'react';

import type {
  ActiveProvider,
  ApprovalRequest,
  CommandId,
  ConnectionState,
  MemoryRecord,
  PluginHealth,
  PluginRecord,
  ProviderHealth,
  Schedule,
  SkillRecord,
  Task,
  ViewId,
} from './contracts.js';
import {
  connectionLabel,
  displayModel,
  displayProviderName,
  relativeTime,
  views,
} from './format.js';

export function NavigationTabs({
  view,
  mobile = false,
  memoryCount,
  automationCount,
  onChange,
}: {
  view: ViewId;
  mobile?: boolean;
  memoryCount: number;
  automationCount: number;
  onChange(view: ViewId): void;
}): React.JSX.Element {
  const navigationViews = mobile
    ? views.filter((item) => ['conversation', 'memory', 'system'].includes(item.id))
    : views;
  return (
    <nav
      className={mobile ? 'mobile-nav' : 'primary-nav'}
      aria-label="NUAAI sections"
      role="tablist"
    >
      {navigationViews.map((item) => (
        <button
          type="button"
          role="tab"
          aria-selected={view === item.id}
          aria-controls={`view-${item.id}`}
          className={view === item.id ? 'active' : ''}
          key={item.id}
          onClick={() => onChange(item.id)}
        >
          <span className="nav-mark" aria-hidden="true" />
          {mobile ? item.shortLabel : item.label}
          {!mobile && item.id === 'memory' && <small>{memoryCount}</small>}
          {!mobile && item.id === 'automations' && <small>{automationCount}</small>}
        </button>
      ))}
    </nav>
  );
}

export function ApprovalInbox({
  approvals,
  decidingIds = new Set<string>(),
  onApprove,
  onDeny,
}: {
  approvals: ApprovalRequest[];
  decidingIds?: ReadonlySet<string>;
  onApprove(id: string, payloadHash: string): void;
  onDeny(id: string, payloadHash: string): void;
}): React.JSX.Element | null {
  if (!approvals?.length) return null;
  return (
    <section className="approval-inbox" aria-label="Action approvals">
      <div className="approval-inbox-heading">
        <div>
          <span className="section-label">Approval required</span>
          <h2>Review action</h2>
        </div>
        <span className="count-chip">{approvals?.length ?? 0} pending</span>
      </div>
      {approvals.map((approval) => (
        <article className="approval-card" key={approval.id} data-status={approval.status}>
          <dl>
            <div>
              <dt>Tool</dt>
              <dd>{approval.toolName}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>{approval.target}</dd>
            </div>
            <div>
              <dt>Risk</dt>
              <dd>{approval.risk}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>
                {approval.preview.context.client}
                {approval.preview.context.sessionId
                  ? ` · Session ${approval.preview.context.sessionId}`
                  : ''}
              </dd>
            </div>
            {approval.preview.fields.map((field) => (
              <div
                className={field.format === 'code' ? 'approval-preview-wide' : undefined}
                key={field.label}
              >
                <dt>{field.label}</dt>
                <dd className={field.format === 'code' ? 'approval-preview-code' : undefined}>
                  {field.value}
                </dd>
              </div>
            ))}
            <div>
              <dt>Payload hash</dt>
              <dd className="approval-hash">{approval.payloadHash}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>
                <time dateTime={new Date(approval.expiresAt).toISOString()}>
                  {new Date(approval.expiresAt).toISOString()}
                </time>
              </dd>
            </div>
          </dl>
          <div className="card-actions">
            <button
              type="button"
              className="primary-button"
              disabled={decidingIds.has(approval.id)}
              onClick={() => onApprove(approval.id, approval.payloadHash)}
            >
              {decidingIds.has(approval.id) ? 'Applying…' : 'Approve once'}
            </button>
            <button
              type="button"
              className="danger-text"
              disabled={decidingIds.has(approval.id)}
              onClick={() => onDeny(approval.id, approval.payloadHash)}
            >
              Deny
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

export function MemoryView({
  memories,
  onDelete,
  saveMemory,
  saveStatus,
  isLoading,
}: {
  memories: MemoryRecord[];
  onDelete?(id: string): void;
  saveMemory?(content: string): void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
  isLoading?: boolean;
}): React.JSX.Element {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; memoryId: string } | null>(
    null,
  );

  const closeContextMenu = (): void => setContextMenu(null);

  return (
    <section
      id="view-memory"
      className="secondary-view"
      role="tabpanel"
      onClick={closeContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeContextMenu();
      }}
    >
      <div className="view-heading">
        <div>
          <span className="section-label">Explicit recall</span>
          <h1>Memory</h1>
          <p>Only information intentionally saved for future sessions appears here.</p>
        </div>
        <span className="count-chip">{memories.length} records</span>
      </div>
      <form
        className="memory-save-form"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const input = form.elements.namedItem('memory-content') as HTMLTextAreaElement;
          if (input?.value?.trim() && saveMemory) {
            saveMemory(input.value.trim());
            input.value = '';
          }
        }}
      >
        <textarea
          name="memory-content"
          placeholder="Save a note to remember across sessions..."
          rows={2}
          disabled={saveStatus === 'saving'}
        />
        <button type="submit" disabled={saveStatus === 'saving'}>
          {saveStatus === 'saving' ? 'Saving...' : 'Save to memory'}
        </button>
        {saveStatus === 'saved' && <span className="save-confirm">Saved</span>}
      </form>
      <div className="record-grid" aria-label="Memory records">
        {memories.length ? (
          memories.map((memory) => (
            <article
              className="record-card memory-card"
              key={memory.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, memoryId: memory.id });
              }}
            >
              <div className="record-topline">
                <span>{memory.hasEmbedding ? 'Indexed' : 'Text only'}</span>
                <time>{relativeTime(memory.createdAt)}</time>
              </div>
              <p>{memory.content}</p>
              {onDelete && (
                <div className="card-actions">
                  <button
                    type="button"
                    className="danger"
                    title="Delete this memory"
                    onClick={() => onDelete(memory.id)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </article>
          ))
        ) : isLoading ? (
          <div className="skeleton-list" aria-label="Loading memories">
            {[1, 2, 3].map((i) => (
              <div className="skeleton-card" key={i}>
                <div className="skeleton-line skeleton-short" />
                <div className="skeleton-line" />
                <div className="skeleton-line skeleton-medium" />
              </div>
            ))}
          </div>
        ) : (
          <div className="section-empty">
            <h2>No saved memory</h2>
            <p>Ask NUAAI to remember something when persistence is useful.</p>
          </div>
        )}
      </div>
      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              onDelete?.(contextMenu.memoryId);
              closeContextMenu();
            }}
          >
            Delete memory
          </button>
        </div>
      )}
    </section>
  );
}

export function AutomationsView({
  schedules,
  tasks,
  scheduleName,
  scheduleInput,
  onScheduleName,
  onScheduleInput,
  onCreate,
  onAction,
  onDelete,
  onUpdate,
}: {
  schedules: Schedule[];
  tasks: Task[];
  scheduleName: string;
  scheduleInput: string;
  onScheduleName(value: string): void;
  onScheduleInput(value: string): void;
  onCreate(): void;
  onAction(id: string, action: 'pause' | 'resume' | 'trigger'): void;
  onDelete?(id: string): void;
  onUpdate?(id: string, name: string, agentInput: string): void;
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editInput, setEditInput] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const startEdit = (id: string): void => {
    const schedule = schedules.find((s) => s.id === id);
    if (!schedule) return;
    setEditingId(id);
    setEditName(schedule.name);
    setEditInput(schedule.agentInput);
  };

  const saveEdit = (): void => {
    if (!editingId || !editName.trim() || !editInput.trim()) return;
    onUpdate?.(editingId, editName.trim(), editInput.trim());
    setEditingId(null);
  };
  return (
    <section id="view-automations" className="secondary-view" role="tabpanel">
      <div className="view-heading">
        <div>
          <span className="section-label">Durable background work</span>
          <h1>Automations</h1>
          <p>Create schedules and see the real terminal state of every task.</p>
        </div>
        <span className="count-chip">
          {schedules.filter((schedule) => schedule.enabled).length} enabled
        </span>
      </div>
      <form
        className="automation-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate();
        }}
      >
        <label>
          <span>Name</span>
          <input
            aria-label="Schedule name"
            value={scheduleName}
            onChange={(event) => onScheduleName(event.target.value)}
            placeholder="Daily workspace briefing"
          />
        </label>
        <label>
          <span>Instruction</span>
          <input
            aria-label="Schedule agent input"
            value={scheduleInput}
            onChange={(event) => onScheduleInput(event.target.value)}
            placeholder="Summarize current project health"
          />
        </label>
        <button
          type="submit"
          className="primary-button"
          disabled={!scheduleName.trim() || !scheduleInput.trim()}
        >
          Create automation
        </button>
      </form>
      <div className="automation-layout">
        <div className="automation-list" aria-label="Automations">
          {schedules.length ? (
            schedules.map((schedule) => {
              const recentTasks = tasks
                .filter((task) => task.scheduleId === schedule.id)
                .slice(0, 3);
              const isEditing = editingId === schedule.id;
              return (
                <article className="record-card automation-card" key={schedule.id}>
                  <div className="record-topline">
                    <span className={schedule.enabled ? 'good-text' : ''}>
                      {schedule.enabled ? 'Enabled' : 'Paused'}
                    </span>
                    <span>{schedule.type}</span>
                  </div>
                  {isEditing ? (
                    <form
                      className="edit-schedule-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveEdit();
                      }}
                    >
                      <input
                        aria-label="Edit name"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                      <textarea
                        aria-label="Edit instruction"
                        value={editInput}
                        onChange={(e) => setEditInput(e.target.value)}
                      />
                      <div className="card-actions">
                        <button type="submit">Save</button>
                        <button type="button" className="danger" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <h2>{schedule.name}</h2>
                      <p>{schedule.agentInput}</p>
                      <div className="automation-meta">
                        <span>Next: {relativeTime(schedule.nextRunAt)}</span>
                        <span>Attempts: {schedule.policy.maxAttempts}</span>
                      </div>
                      {recentTasks.length > 0 && (
                        <div className="task-chips">
                          {recentTasks.map((task) => (
                            <button
                              type="button"
                              className={`task-chip task-${task.status}`}
                              key={task.id}
                              title="View task details"
                              onClick={() =>
                                setSelectedTaskId(selectedTaskId === task.id ? null : task.id)
                              }
                            >
                              {task.status}
                            </button>
                          ))}
                        </div>
                      )}
                      {selectedTaskId && (
                        <TaskDetail
                          task={tasks.find((t) => t.id === selectedTaskId)}
                          onClose={() => setSelectedTaskId(null)}
                        />
                      )}
                      <div className="card-actions">
                        <button
                          type="button"
                          title="Trigger this automation now"
                          onClick={() => onAction(schedule.id, 'trigger')}
                        >
                          Run now
                        </button>
                        <button
                          type="button"
                          title={
                            schedule.enabled ? 'Pause this automation' : 'Resume this automation'
                          }
                          onClick={() =>
                            onAction(schedule.id, schedule.enabled ? 'pause' : 'resume')
                          }
                        >
                          {schedule.enabled ? 'Pause' : 'Resume'}
                        </button>
                        <button
                          type="button"
                          title="Edit automation name and instruction"
                          onClick={() => startEdit(schedule.id)}
                        >
                          Edit
                        </button>
                        {onDelete && (
                          <button
                            type="button"
                            className="danger"
                            title="Delete this automation"
                            onClick={() => onDelete(schedule.id)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </article>
              );
            })
          ) : (
            <div className="section-empty">
              <h2>No automations</h2>
              <p>
                Create a manual automation above. Time-based schedules remain available through the
                TUI.
              </p>
            </div>
          )}
        </div>
        <aside className="task-history" aria-label="Task history">
          <span className="section-label">Recent tasks</span>
          {tasks.length ? (
            tasks.slice(0, 10).map((task) => (
              <div className="task-row" key={task.id}>
                <span className={`action-icon action-${task.status}`} aria-hidden="true" />
                <div>
                  <strong>{String(task.payload.name ?? task.kind)}</strong>
                  <small>
                    {task.status} · {relativeTime(task.updatedAt)}
                  </small>
                </div>
              </div>
            ))
          ) : (
            <p className="quiet-copy">Task outcomes will appear here.</p>
          )}
        </aside>
      </div>
    </section>
  );
}

export function SystemView({
  connection,
  activeProvider,
  providers,
  skills,
  plugins,
  pluginHealth,
  onSwitchProvider,
  onUnloadPlugin,
  onEnableSkill,
  onDisableSkill,
  onConfigurePlugin,
}: {
  connection: ConnectionState;
  activeProvider: ActiveProvider | null;
  providers: ProviderHealth[];
  skills: SkillRecord[];
  plugins: PluginRecord[];
  pluginHealth: PluginHealth[];
  onSwitchProvider(provider: string, model: string): void;
  onUnloadPlugin(name: string): void;
  onEnableSkill?(name: string): void;
  onDisableSkill?(name: string): void;
  onConfigurePlugin?(name: string, config: Record<string, unknown>): void;
}): React.JSX.Element {
  const [configuringPlugin, setConfiguringPlugin] = useState<string | null>(null);
  const [configText, setConfigText] = useState('');
  return (
    <section id="view-system" className="secondary-view" role="tabpanel">
      <div className="view-heading">
        <div>
          <span className="section-label">Runtime and capabilities</span>
          <h1>System</h1>
          <p>Provider health, active model, skills, and trusted plugins.</p>
        </div>
        <span className={`connection-badge connection-${connection}`}>
          {connectionLabel(connection)}
        </span>
      </div>
      <div className="system-section">
        <div className="section-heading-row">
          <h2>Providers</h2>
          <span>{displayModel(activeProvider)}</span>
        </div>
        <div className="provider-grid">
          {providers.map((provider) => (
            <article className="record-card provider-card" key={provider.name}>
              <div className="provider-title">
                <span
                  className={`connection-dot ${provider.available ? 'connection-connected' : 'connection-offline'}`}
                  aria-hidden="true"
                />
                <h3>{displayProviderName(provider.name)}</h3>
                <strong>{provider.available ? 'Ready' : 'Offline'}</strong>
              </div>
              <p>{provider.detail}</p>
              {provider.models?.length ? (
                <div className="model-actions">
                  {provider.models.map((model) => (
                    <button
                      type="button"
                      disabled={
                        !provider.available ||
                        (activeProvider?.name === provider.name && activeProvider.model === model)
                      }
                      key={model}
                      onClick={() => onSwitchProvider(provider.name, model)}
                    >
                      {activeProvider?.name === provider.name && activeProvider.model === model
                        ? 'Active'
                        : model}
                    </button>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </div>
      <div className="system-columns">
        <div className="system-section">
          <div className="section-heading-row">
            <h2>Skills</h2>
            <span>{skills.length}</span>
          </div>
          <div className="compact-list" aria-label="Skills">
            {skills.length ? (
              skills.map((skill) => (
                <article key={skill.name}>
                  <div>
                    <strong>{skill.name}</strong>
                    <small>
                      {skill.version} · {skill.source}
                    </small>
                  </div>
                  <p>{skill.description}</p>
                  {(onEnableSkill || onDisableSkill) && (
                    <div className="card-actions">
                      {skill.enabled === false ? (
                        <button
                          type="button"
                          title="Enable this skill"
                          onClick={() => onEnableSkill?.(skill.name)}
                        >
                          Enable
                        </button>
                      ) : (
                        <button
                          type="button"
                          title="Disable this skill"
                          onClick={() => onDisableSkill?.(skill.name)}
                        >
                          Disable
                        </button>
                      )}
                    </div>
                  )}
                </article>
              ))
            ) : (
              <p className="quiet-copy">No skills registered.</p>
            )}
          </div>
        </div>
        <div className="system-section">
          <div className="section-heading-row">
            <h2>Plugins</h2>
            <span>{plugins.length}</span>
          </div>
          <div className="compact-list" aria-label="Plugins">
            {plugins.length ? (
              plugins.map((plugin) => {
                const health = pluginHealth.find((item) => item.name === plugin.name);
                const isConfiguring = configuringPlugin === plugin.name;
                return (
                  <article key={plugin.name}>
                    <div>
                      <strong>{plugin.name}</strong>
                      <small>
                        {plugin.version} · {health?.enabled ? 'enabled' : 'disabled'}
                      </small>
                    </div>
                    <p>{plugin.capabilities.join(', ') || 'No declared capabilities'}</p>
                    {isConfiguring ? (
                      <form
                        className="plugin-config-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          try {
                            const parsed = JSON.parse(configText);
                            onConfigurePlugin?.(plugin.name, parsed);
                            setConfiguringPlugin(null);
                          } catch {
                            // invalid JSON, ignore
                          }
                        }}
                      >
                        <textarea
                          aria-label="Plugin config (JSON)"
                          value={configText}
                          onChange={(e) => setConfigText(e.target.value)}
                          placeholder='{"key": "value"}'
                        />
                        <div className="card-actions">
                          <button type="submit">Save</button>
                          <button type="button" onClick={() => setConfiguringPlugin(null)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="card-actions">
                        {plugin.config && Object.keys(plugin.config).length > 0 && (
                          <small className="config-preview">
                            {Object.keys(plugin.config).join(', ')}
                          </small>
                        )}
                        <button
                          type="button"
                          title="Configure plugin"
                          onClick={() => {
                            setConfiguringPlugin(plugin.name);
                            setConfigText(
                              plugin.config ? JSON.stringify(plugin.config, null, 2) : '{}',
                            );
                          }}
                        >
                          Configure
                        </button>
                        <button
                          type="button"
                          className="text-button danger-text"
                          onClick={() => onUnloadPlugin(plugin.name)}
                        >
                          Unload
                        </button>
                      </div>
                    )}
                  </article>
                );
              })
            ) : (
              <p className="quiet-copy">No trusted plugins loaded.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function ErrorToast({
  title = 'NUAAI needs attention',
  error,
  onRetry,
  onDismiss,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
  onDismiss(): void;
}): React.JSX.Element {
  return (
    <div className="error-toast" role="alert">
      <div>
        <strong>{title}</strong>
        <p>{error}</p>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
      <button type="button" aria-label="Dismiss error" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

export function TaskDetail({
  task,
  onClose,
}: {
  task?: Task;
  onClose(): void;
}): React.JSX.Element | null {
  if (!task) return null;
  return (
    <section className="task-detail" aria-label="Task details">
      <div className="task-detail-header">
        <h3>Task {task.kind}</h3>
        <button
          type="button"
          className="icon-button"
          aria-label="Close task details"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <dl>
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`task-chip task-${task.status}`}>{task.status}</span>
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{relativeTime(task.updatedAt)}</dd>
        </div>
        {task.scheduleId && (
          <div>
            <dt>Schedule</dt>
            <dd>{task.scheduleId}</dd>
          </div>
        )}
        {task.payload && Object.keys(task.payload).length > 0 && (
          <div>
            <dt>Payload</dt>
            <dd>
              <pre>{JSON.stringify(task.payload, null, 2)}</pre>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

export function CommandPalette({
  activeRunId,
  selectedSessionId,
  firstActionRef,
  onExecute,
  onClose,
}: {
  activeRunId: string | null;
  selectedSessionId: string | null;
  firstActionRef: RefObject<HTMLButtonElement | null>;
  onExecute(id: CommandId): void;
  onClose(): void;
}): React.JSX.Element {
  const commands: Array<[CommandId, string, string, string]> = [
    ['new-session', 'New conversation', 'Create a durable session', 'N'],
    ['new-thread', 'New thread', 'Continue this session in a clean thread', 'T'],
    ['focus-composer', 'Focus composer', 'Jump back to the conversation', 'A'],
    ['refresh', 'Refresh runtime', 'Reload daemon and system state', 'R'],
    ['cancel-run', 'Cancel active run', 'Stop the current agent task', 'Esc'],
  ];
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <dialog open className="command-palette" aria-labelledby="command-title">
        <div className="dialog-heading">
          <div>
            <span className="section-label">Quick actions</span>
            <h2 id="command-title">Commands</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close commands"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="command-list">
          {commands.map(([id, label, description, shortcut], index) => (
            <button
              type="button"
              className="command-row"
              disabled={
                (id === 'cancel-run' && !activeRunId) || (id === 'new-thread' && !selectedSessionId)
              }
              key={id}
              ref={index === 0 ? firstActionRef : undefined}
              onClick={() => onExecute(id)}
            >
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
              <kbd>{shortcut}</kbd>
            </button>
          ))}
        </div>
        <p className="dialog-hint">
          Read-only is the default run profile. Elevated actions require an explicit local
          configuration.
        </p>
      </dialog>
    </div>
  );
}
