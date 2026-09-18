import { useMemo, useState } from 'react';
import type { RefObject } from 'react';

import { EmptyState } from './components/EmptyState.js';
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
  onUpdate,
  saveMemory,
  saveStatus,
  isLoading,
}: {
  memories: MemoryRecord[];
  onDelete?(id: string): void;
  onUpdate?(id: string, content: string): void;
  saveMemory?(content: string): void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
  isLoading?: boolean;
}): React.JSX.Element {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; memoryId: string } | null>(
    null,
  );
  const [editingMemory, setEditingMemory] = useState<MemoryRecord | null>(null);
  const [editContent, setEditContent] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'indexed' | 'text'>('all');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const filteredMemories = useMemo(() => {
    let result = [...memories];
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((m) => m.content.toLowerCase().includes(query));
    }
    if (filterType !== 'all') {
      result = result.filter((m) => (filterType === 'indexed' ? m.hasEmbedding : !m.hasEmbedding));
    }
    result.sort((a, b) =>
      sortOrder === 'newest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
    );
    return result;
  }, [memories, searchQuery, filterType, sortOrder]);

  const toggleSelect = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (): void => {
    if (selectedIds.size === filteredMemories.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredMemories.map((m) => m.id)));
    }
  };

  const deleteSelected = (): void => {
    for (const id of selectedIds) {
      onDelete?.(id);
    }
    setSelectedIds(new Set());
  };

  const closeContextMenu = (): void => setContextMenu(null);

  const startEdit = (memory: MemoryRecord): void => {
    setEditingMemory(memory);
    setEditContent(memory.content);
  };

  const cancelEdit = (): void => {
    setEditingMemory(null);
    setEditContent('');
  };

  const saveEdit = (): void => {
    if (!editingMemory || !editContent.trim()) return;
    onUpdate?.(editingMemory.id, editContent.trim());
    setEditingMemory(null);
    setEditContent('');
  };

  return (
    <>
      <section
        id="view-memory"
        className="secondary-view"
        role="tabpanel"
        onClick={closeContextMenu}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            closeContextMenu();
          }
        }}
      >
        <div className="view-heading">
          <div>
            <span className="section-label">Explicit recall</span>
            <h1>Memory</h1>
            <p>Only information intentionally saved for future sessions appears here.</p>
          </div>
          <span className="count-chip">
            {filteredMemories.length} of {memories.length} records
          </span>
        </div>
        <div className="memory-controls">
          <input
            type="search"
            className="memory-search"
            placeholder="Search memories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search memories"
          />
          <div className="memory-filter-controls">
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as 'all' | 'indexed' | 'text')}
              aria-label="Filter by type"
            >
              <option value="all">All types</option>
              <option value="indexed">Indexed</option>
              <option value="text">Text only</option>
            </select>
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as 'newest' | 'oldest')}
              aria-label="Sort order"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>
        </div>
        {selectedIds.size > 0 && (
          <div className="bulk-action-bar">
            <span>{selectedIds.size} selected</span>
            <button type="button" className="danger-btn" onClick={deleteSelected}>
              Delete selected
            </button>
            <button type="button" onClick={() => setSelectedIds(new Set())}>
              Cancel
            </button>
          </div>
        )}
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
          {filteredMemories.length ? (
            <>
              {selectedIds.size > 0 && selectedIds.size < filteredMemories.length && (
                <div className="memory-list-header">
                  <label>
                    <input
                      type="checkbox"
                      checked={false}
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                    Select all
                  </label>
                </div>
              )}
              {filteredMemories.map((memory) => (
                <div
                  className={`memory-row ${selectedIds.has(memory.id) ? 'selected' : ''}`}
                  key={memory.id}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, memoryId: memory.id });
                  }}
                >
                  <input
                    type="checkbox"
                    className="memory-checkbox"
                    checked={selectedIds.has(memory.id)}
                    onChange={() => toggleSelect(memory.id)}
                    aria-label={`Select memory: ${memory.content.slice(0, 30)}`}
                  />
                  <div className="memory-content">
                    <p>{memory.content}</p>
                  </div>
                  <div className="memory-meta">
                    <span className={memory.hasEmbedding ? 'indexed' : 'text-only'}>
                      {memory.hasEmbedding ? 'Indexed' : 'Text'}
                    </span>
                    <time>{relativeTime(memory.createdAt)}</time>
                  </div>
                  <div className="memory-actions">
                    {onUpdate && (
                      <button
                        type="button"
                        className="memory-action-btn"
                        title="Edit this memory"
                        onClick={() => startEdit(memory)}
                      >
                        Edit
                      </button>
                    )}
                    {onDelete && (
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
                </div>
              ))}
            </>
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
            <EmptyState
              title="No saved memory"
              description="Ask NUAAI to remember something when persistence is useful."
              icon="◉"
            />
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
              onClick={() => {
                const memory = memories.find((m) => m.id === contextMenu.memoryId);
                if (memory) startEdit(memory);
                closeContextMenu();
              }}
            >
              Edit memory
            </button>
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
      {editingMemory && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) cancelEdit();
          }}
        >
          <dialog open className="memory-edit-modal" aria-labelledby="edit-memory-title">
            <div className="dialog-heading">
              <div>
                <span className="section-label">Edit memory</span>
                <h2 id="edit-memory-title">
                  {editingMemory.content.substring(0, 50)}
                  {editingMemory.content.length > 50 ? '...' : ''}
                </h2>
              </div>
              <button type="button" className="icon-button" aria-label="Close" onClick={cancelEdit}>
                ×
              </button>
            </div>
            <div className="memory-edit-modal-content">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={8}
              />
            </div>
            <div className="memory-edit-modal-actions">
              <button type="button" onClick={saveEdit}>
                Save changes
              </button>
              <button type="button" className="danger" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          </dialog>
        </div>
      )}
    </>
  );
}

export function AutomationsView({
  schedules,
  scheduleName,
  scheduleInput,
  scheduleType,
  scheduleExpression,
  onScheduleName,
  onScheduleInput,
  onScheduleType,
  onScheduleExpression,
  onCreate,
  onAction,
  onDelete,
  onUpdate,
}: {
  schedules: Schedule[];
  scheduleName: string;
  scheduleInput: string;
  scheduleType: 'manual' | 'interval' | 'cron';
  scheduleExpression: string;
  onScheduleName(value: string): void;
  onScheduleInput(value: string): void;
  onScheduleType(value: 'manual' | 'interval' | 'cron'): void;
  onScheduleExpression(value: string): void;
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
        <div className="automation-form-row">
          <label className="automation-type-select">
            <span>Type</span>
            <select
              aria-label="Schedule type"
              value={scheduleType}
              onChange={(event) =>
                onScheduleType(event.target.value as 'manual' | 'interval' | 'cron')
              }
            >
              <option value="manual">Manual</option>
              <option value="interval">Interval</option>
              <option value="cron">Cron</option>
            </select>
          </label>
          {scheduleType !== 'manual' && (
            <label className="automation-expression">
              <span>
                {scheduleType === 'interval' ? 'Interval (e.g., 1h, 30m)' : 'Cron expression'}
              </span>
              <input
                aria-label="Schedule expression"
                value={scheduleExpression}
                onChange={(event) => onScheduleExpression(event.target.value)}
                placeholder={scheduleType === 'interval' ? '1h' : '0 * * * *'}
              />
            </label>
          )}
        </div>
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
          disabled={
            !scheduleName.trim() ||
            !scheduleInput.trim() ||
            (scheduleType !== 'manual' && !scheduleExpression.trim())
          }
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
              <details className="skill-details" key={skill.name}>
                <summary className="skill-summary">
                  <div className="settings-row-info">
                    <strong>{skill.name}</strong>
                    <span>{skill.description}</span>
                  </div>
                  <div className="settings-row-meta">
                    <span className="skill-source">{skill.source}</span>
                    <span className="skill-version">v{skill.version}</span>
                    {(onEnableSkill || onDisableSkill) && (
                      <button
                        type="button"
                        className={`toggle-btn ${skill.enabled === false ? 'disabled' : 'enabled'}`}
                        onClick={(e) => {
                          e.preventDefault();
                          skill.enabled === false
                            ? onEnableSkill?.(skill.name)
                            : onDisableSkill?.(skill.name);
                        }}
                      >
                        {skill.enabled === false ? 'Disabled' : 'Enabled'}
                      </button>
                    )}
                  </div>
                </summary>
                <div className="skill-detail-content">
                  {skill.triggers.length > 0 && (
                    <div className="skill-triggers">
                      <strong>Trigger words:</strong>
                      <div className="skill-trigger-tags">
                        {skill.triggers.map((trigger) => (
                          <span key={trigger} className="trigger-tag">
                            {trigger}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </details>
            ))
          ) : (
            <EmptyState
              title="No skills registered"
              description="Skills are loaded from the skills/ directory and can trigger automations."
              icon="◎"
            />
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
            <EmptyState
              title="No trusted plugins loaded"
              description="Plugins extend NUAAI capabilities. Configure trusted plugins to see them here."
              icon="⊞"
            />
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

interface KeyboardShortcutsOverlayProps {
  onClose(): void;
}

export function KeyboardShortcutsOverlay({
  onClose,
}: KeyboardShortcutsOverlayProps): React.JSX.Element {
  const shortcutSections = [
    {
      title: 'Global',
      shortcuts: [
        ['Show keyboard shortcuts', '?'],
        ['Open command palette', 'Ctrl+K'],
        ['Close dialog or panel', 'Esc'],
      ],
    },
    {
      title: 'Navigation',
      shortcuts: [
        ['Conversation view', 'Ctrl+1'],
        ['Memory view', 'Ctrl+2'],
        ['Automations view', 'Ctrl+3'],
        ['System view', 'Ctrl+4'],
      ],
    },
    {
      title: 'Sessions',
      shortcuts: [
        ['New session', 'Ctrl+N'],
        ['New thread', 'Ctrl+T'],
        ['Collapse sidebar', 'Ctrl+B'],
        ['Rename session (double-click)', '—'],
        ['Delete session (right-click)', '—'],
      ],
    },
    {
      title: 'Conversation',
      shortcuts: [
        ['Send message', 'Enter'],
        ['New line in message', 'Shift+Enter'],
        ['Cancel running agent', 'Esc'],
        ['Retry last response', 'Ctrl+Enter'],
      ],
    },
    {
      title: 'Help',
      shortcuts: [
        ['Show this help', '?'],
        ['Toggle command palette', 'Ctrl+P'],
      ],
    },
  ];

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <dialog open className="shortcuts-overlay" aria-labelledby="shortcuts-title">
        <div className="dialog-heading">
          <div>
            <span className="section-label">Keyboard</span>
            <h2 id="shortcuts-title">Keyboard Shortcuts</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close shortcuts"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="shortcuts-grid">
          {shortcutSections.map((section) => (
            <div className="shortcuts-section" key={section.title}>
              <h3>{section.title}</h3>
              <dl>
                {section.shortcuts.map(([action, key]) => (
                  <div key={action}>
                    <dt>
                      <kbd>{key}</kbd>
                      <span>{action}</span>
                    </dt>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        <p className="dialog-hint">
          Press <kbd>?</kbd> to toggle this overlay.
        </p>
      </dialog>
    </div>
  );
}

interface BottomPanelProps {
  isOpen: boolean;
  onToggle(): void;
  activeRunId: string | null;
  runProjection?: {
    status: string;
  } | null;
  liveOutput?: string | null;
}

export function BottomPanel({
  isOpen,
  onToggle,
  activeRunId,
  runProjection,
  liveOutput,
}: BottomPanelProps): React.JSX.Element {
  return (
    <div className={`bottom-panel ${isOpen ? 'open' : ''}`}>
      <div className="bottom-panel-header">
        <button
          type="button"
          className="bottom-panel-toggle"
          onClick={onToggle}
          aria-expanded={isOpen}
          title={isOpen ? 'Collapse panel (Ctrl+J)' : 'Expand panel (Ctrl+J)'}
        >
          <span className="bottom-panel-icon">{isOpen ? '⌄' : '⌃'}</span>
          <span>Activity</span>
          {activeRunId && <span className="bottom-panel-badge">Active</span>}
        </button>
      </div>
      {isOpen && (
        <div className="bottom-panel-content">
          <div className="bottom-panel-section">
            <h3>Current Run</h3>
            {activeRunId ? (
              <div className="run-status">
                <span className={`run-badge run-${runProjection?.status ?? 'running'}`}>
                  {runProjection?.status ?? 'running'}
                </span>
              </div>
            ) : (
              <p className="no-active-run">No active run</p>
            )}
          </div>
          {liveOutput && (
            <div className="bottom-panel-section">
              <h3>Live Output</h3>
              <pre className="live-output">{liveOutput}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
