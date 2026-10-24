import { useState } from 'react';
import type { RefObject } from 'react';

import type {
  ActiveProvider,
  ApprovalRequest,
  CommandId,
  ConnectionState,
  LearningStatus,
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
  learning,
  changingLearning,
  onLearningMode,
  onRevert,
  revertingId,
  onDelete,
  saveMemory,
  saveStatus,
  isLoading,
}: {
  memories: MemoryRecord[];
  learning: LearningStatus | null;
  changingLearning: boolean;
  onLearningMode(mode: LearningStatus['mode']): void;
  onRevert(id: string): void;
  revertingId: string | null;
  onDelete?(id: string): void;
  saveMemory?(content: string): void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
  isLoading?: boolean;
}): React.JSX.Element {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; memoryId: string } | null>(
    null,
  );

  const closeContextMenu = (): void => setContextMenu(null);
  const active = memories.filter(
    (memory) =>
      !['superseded', 'disabled'].includes(String(memoryKnowledge(memory).state ?? 'active')),
  );
  const retired = memories.filter((memory) =>
    ['superseded', 'disabled'].includes(String(memoryKnowledge(memory).state)),
  );

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
          <span className="section-label">Durable knowledge</span>
          <h1>Memory</h1>
          <p>
            Saved notes and selectively learned project knowledge, with retained evidence and
            history.
          </p>
        </div>
        <span className="count-chip">{memories.length} records</span>
      </div>
      <div className="learning-controls">
        <div>
          <label htmlFor="agent-learning">Agent learning</label>
          <p>
            {!learning
              ? 'Loading the actual setting…'
              : !learning.available
                ? 'Automatic learning is unavailable in this runtime.'
                : learning.mode === 'automatic'
                  ? 'Selectively reviews meaningful completed work. Verified project knowledge can be saved without a remember command.'
                  : learning.mode === 'manual'
                    ? 'No automatic review. The agent saves only when explicitly asked.'
                    : 'Automatic review and agent saves are off. Existing notes remain available; notes can still be managed here.'}
          </p>
        </div>
        <select
          id="agent-learning"
          value={learning?.mode ?? ''}
          disabled={!learning?.available || changingLearning}
          onChange={(event) => onLearningMode(event.target.value as LearningStatus['mode'])}
        >
          <option value="" disabled>
            Loading…
          </option>
          <option value="automatic">Automatic</option>
          <option value="manual">Manual</option>
          <option value="off">Off</option>
        </select>
        {changingLearning && <output>Saving and verifying…</output>}
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
      <div className="memory-list" aria-label="Memory records">
        {active.length ? (
          active.map((memory) => (
            <div
              className="memory-row"
              key={memory.id}
              onContextMenu={(e) => {
                e.preventDefault();
                if (memoryKnowledge(memory).origin !== 'automatic')
                  setContextMenu({ x: e.clientX, y: e.clientY, memoryId: memory.id });
              }}
            >
              <div className="memory-content">
                <p>{memory.content}</p>
                <span className="knowledge-origin">
                  {memoryKnowledge(memory).origin === 'automatic'
                    ? 'Learned automatically'
                    : 'Saved note'}
                </span>
                <MemoryEvidence memory={memory} />
              </div>
              <div className="memory-meta">
                <span className={memory.hasEmbedding ? 'indexed' : 'text-only'}>
                  {memory.hasEmbedding ? 'Indexed' : 'Text'}
                </span>
                <time>{relativeTime(memory.createdAt)}</time>
              </div>
              {memoryKnowledge(memory).origin === 'automatic' && (
                <button
                  type="button"
                  disabled={revertingId !== null}
                  onClick={() => onRevert(memory.id)}
                >
                  {revertingId === memory.id ? 'Verifying undo…' : 'Undo learning'}
                </button>
              )}
              {onDelete && memoryKnowledge(memory).origin !== 'automatic' && (
                <button
                  type="button"
                  className="memory-delete-btn danger"
                  title="Delete this memory"
                  onClick={() => onDelete(memory.id)}
                >
                  Delete
                </button>
              )}
            </div>
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
            <p>
              Useful project preferences and verified workflows can appear after meaningful work
              when automatic learning is enabled. A note can also be saved explicitly.
            </p>
          </div>
        )}
      </div>
      {retired.length > 0 && (
        <details className="learning-history">
          <summary>Learning history</summary>
          <div aria-label="Retired learning">
            {retired.map((memory) => (
              <article key={memory.id}>
                <p>{memory.content}</p>
                <small>
                  {String(memoryKnowledge(memory).state)} · retained for review, not recalled
                </small>
                <MemoryEvidence memory={memory} />
              </article>
            ))}
          </div>
        </details>
      )}
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

function memoryKnowledge(memory: MemoryRecord): Record<string, unknown> {
  const value = memory.metadata?.knowledge;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function MemoryEvidence({ memory }: { memory: MemoryRecord }): React.JSX.Element | null {
  const knowledge = memoryKnowledge(memory);
  if (!Object.keys(knowledge).length) return null;
  return (
    <details className="memory-evidence">
      <summary>Evidence and scope</summary>
      <dl>
        <dt>Applies to</dt>
        <dd>
          {knowledge.scope === 'workspace'
            ? String(knowledge.workspaceRoot ?? 'Unknown workspace')
            : 'Profile'}
        </dd>
        <dt>Origin</dt>
        <dd>{String(knowledge.origin ?? 'Unspecified')}</dd>
        {typeof knowledge.sourceRunId === 'string' && (
          <>
            <dt>Source run</dt>
            <dd>
              <code>{String(knowledge.sourceRunId)}</code>
            </dd>
          </>
        )}
        {typeof knowledge.topic === 'string' && (
          <>
            <dt>Topic</dt>
            <dd>{String(knowledge.topic)}</dd>
          </>
        )}
      </dl>
      {typeof knowledge.sourceQuote === 'string' && knowledge.sourceQuote && (
        <blockquote>{knowledge.sourceQuote}</blockquote>
      )}
      {Array.isArray(knowledge.evidenceCallIds) && knowledge.evidenceCallIds.length > 0 && (
        <p>
          Recorded successful calls: {knowledge.evidenceCallIds.slice(0, 8).map(String).join(', ')}
        </p>
      )}
    </details>
  );
}

export function AutomationsView({
  schedules,
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
          <p>Schedules that run tasks on a timer or trigger.</p>
        </div>
        <span className="count-chip">
          {schedules.filter((schedule) => schedule.enabled).length} of {schedules.length} enabled
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
      <div className="schedule-list" aria-label="Schedules">
        {schedules.length ? (
          schedules.map((schedule) => {
            const isEditing = editingId === schedule.id;
            return (
              <div className="schedule-row" key={schedule.id}>
                {isEditing ? (
                  <form
                    className="schedule-edit-form"
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
                    <div className="schedule-edit-actions">
                      <button type="submit">Save</button>
                      <button type="button" className="danger" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="schedule-info">
                      <div className="schedule-title-row">
                        <h2>{schedule.name}</h2>
                        <span
                          className={`schedule-status ${schedule.enabled ? 'enabled' : 'paused'}`}
                        >
                          {schedule.enabled ? 'Enabled' : 'Paused'}
                        </span>
                      </div>
                      <p className="schedule-input">{schedule.agentInput}</p>
                      <div className="schedule-meta">
                        <span>{schedule.type}</span>
                        <span>Next: {relativeTime(schedule.nextRunAt)}</span>
                      </div>
                    </div>
                    <div className="schedule-actions">
                      <button
                        type="button"
                        title="Trigger this automation now"
                        onClick={() => onAction(schedule.id, 'trigger')}
                      >
                        Run
                      </button>
                      <button
                        type="button"
                        title={
                          schedule.enabled ? 'Pause this automation' : 'Resume this automation'
                        }
                        onClick={() => onAction(schedule.id, schedule.enabled ? 'pause' : 'resume')}
                      >
                        {schedule.enabled ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        type="button"
                        title="Edit automation"
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
              </div>
            );
          })
        ) : (
          <div className="section-empty">
            <h2>No automations</h2>
            <p>Create one above to schedule recurring background work.</p>
          </div>
        )}
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
          <p>Provider health, active model, skills, and plugins.</p>
        </div>
        <span className={`connection-badge connection-${connection}`}>
          {connectionLabel(connection)}
        </span>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h2>Provider</h2>
          <span className="current-model">{displayModel(activeProvider)}</span>
        </div>
        <div className="provider-list">
          {providers.map((provider) => (
            <div className="provider-row" key={provider.name}>
              <div className="provider-info">
                <span
                  className={`connection-dot ${provider.available ? 'connection-connected' : 'connection-offline'}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>{displayProviderName(provider.name)}</strong>
                  <span className="provider-status">
                    {provider.available ? 'Ready' : 'Offline'}
                    {provider.detail && ` · ${provider.detail}`}
                  </span>
                </div>
              </div>
              {provider.models?.length ? (
                <div className="model-list">
                  {provider.models.map((model) => (
                    <button
                      type="button"
                      className={`model-btn ${activeProvider?.name === provider.name && activeProvider.model === model ? 'active' : ''}`}
                      disabled={
                        !provider.available ||
                        (activeProvider?.name === provider.name && activeProvider.model === model)
                      }
                      key={model}
                      onClick={() => onSwitchProvider(provider.name, model)}
                    >
                      {model}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h2>Skills</h2>
          <span className="count-badge">{skills.length}</span>
        </div>
        <div className="settings-list" aria-label="Skills">
          {skills.length ? (
            skills.map((skill) => (
              <div className="settings-row" key={skill.name}>
                <div className="settings-row-info">
                  <strong>{skill.name}</strong>
                  <span>{skill.description}</span>
                </div>
                <div className="settings-row-meta">
                  <span className="skill-source">{skill.source}</span>
                  <span className="skill-version">v{skill.version}</span>
                </div>
                {(onEnableSkill || onDisableSkill) && (
                  <button
                    type="button"
                    className={`toggle-btn ${skill.enabled === false ? 'disabled' : 'enabled'}`}
                    onClick={() =>
                      skill.enabled === false
                        ? onEnableSkill?.(skill.name)
                        : onDisableSkill?.(skill.name)
                    }
                  >
                    {skill.enabled === false ? 'Disabled' : 'Enabled'}
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="quiet-copy">No skills registered.</p>
          )}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h2>Plugins</h2>
          <span className="count-badge">{plugins.length}</span>
        </div>
        <div className="settings-list" aria-label="Plugins">
          {plugins.length ? (
            plugins.map((plugin) => {
              const health = pluginHealth.find((item) => item.name === plugin.name);
              const isConfiguring = configuringPlugin === plugin.name;
              return (
                <div className="settings-row" key={plugin.name}>
                  <div className="settings-row-info">
                    <strong>{plugin.name}</strong>
                    <span>{plugin.capabilities.join(', ') || 'No declared capabilities'}</span>
                  </div>
                  <div className="settings-row-meta">
                    <span className="plugin-version">v{plugin.version}</span>
                    <span className={health?.enabled ? 'plugin-enabled' : 'plugin-disabled'}>
                      {health?.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
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
                      <div className="plugin-config-actions">
                        <button type="submit">Save</button>
                        <button type="button" onClick={() => setConfiguringPlugin(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="settings-row-actions">
                      <button
                        type="button"
                        className="secondary-btn"
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
                        className="danger-btn"
                        onClick={() => onUnloadPlugin(plugin.name)}
                      >
                        Unload
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <p className="quiet-copy">No trusted plugins loaded.</p>
          )}
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
    ['identity', 'Instruction sources', 'Inspect the retained SOUL.md and AGENTS.md snapshot', ''],
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
                (id === 'cancel-run' && !activeRunId) ||
                ((id === 'new-thread' || id === 'identity') && !selectedSessionId)
              }
              key={id}
              ref={index === 0 ? firstActionRef : undefined}
              onClick={() => onExecute(id)}
            >
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
              {shortcut && <kbd>{shortcut}</kbd>}
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
