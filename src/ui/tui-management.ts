import type { PickerItem, PickerState } from './tui-picker.js';
import type { TuiMemory, TuiSchedule, TuiTask } from './tui-state.js';

export type ManagedResource = 'sessions' | 'threads' | 'memory' | 'schedules' | 'tasks';
export type ManagementAction = {
  resource: ManagedResource;
  id: string;
  action: 'delete' | 'pause' | 'resume' | 'trigger' | 'cancel' | 'edit' | 'revert';
};
function memoryKnowledge(memory: TuiMemory): Record<string, unknown> {
  const value = memory.metadata?.knowledge;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function actionItem(action: ManagementAction, label: string): PickerItem {
  return { id: `manage:${JSON.stringify(action)}`, label };
}
export function managementList(
  entry:
    | { kind: 'memory'; values: TuiMemory[] }
    | { kind: 'schedules'; values: TuiSchedule[] }
    | { kind: 'tasks'; values: TuiTask[] },
): PickerState {
  const items =
    entry.kind === 'memory'
      ? entry.values.map((value) => ({
          id: `inspect:${JSON.stringify(['memory', value.id])}`,
          label: value.content,
          detail: `${memoryKnowledge(value).origin === 'automatic' ? 'Learned automatically' : 'Saved note'} · ${String(memoryKnowledge(value).state ?? 'active')} · ${value.hasEmbedding ? 'Semantic index' : 'Lexical index'}`,
        }))
      : entry.kind === 'schedules'
        ? entry.values.map((value) => ({
            id: `inspect:${JSON.stringify(['schedules', value.id])}`,
            label: value.name,
            detail: `${value.enabled ? 'enabled' : 'paused'} · ${value.type}`,
          }))
        : entry.values.map((value) => ({
            id: `inspect:${JSON.stringify(['tasks', value.id])}`,
            label: `${value.kind} · ${value.status}`,
            detail: value.id,
          }));
  return {
    title:
      entry.kind === 'memory'
        ? 'Search memories'
        : entry.kind === 'schedules'
          ? 'Automations'
          : 'Background tasks',
    items,
    query: '',
    index: 0,
    detail:
      entry.kind === 'memory'
        ? [
            'Saved notes and selectively learned project knowledge. /settings controls learning; /remember <text> adds a note.',
          ]
        : entry.kind === 'schedules'
          ? ['Use /schedule to create an automation. Select one to manage it.']
          : undefined,
  };
}

export function managementMenu(
  entry:
    | { kind: 'memory'; value: TuiMemory }
    | { kind: 'schedules'; value: TuiSchedule }
    | { kind: 'tasks'; value: TuiTask },
): PickerState {
  const { value, kind } = entry;
  const items: PickerItem[] = [{ id: 'dismiss', label: 'Back · keep unchanged' }];
  let title: string;
  let detail: string[];
  if (kind === 'memory') {
    title = 'Memory details';
    const knowledge = memoryKnowledge(entry.value);
    const automatic = knowledge.origin === 'automatic';
    detail = [
      entry.value.content,
      `Origin: ${automatic ? 'Learned automatically' : 'Saved note'}`,
      `State: ${String(knowledge.state ?? 'active')}`,
      knowledge.scope === 'workspace'
        ? `Workspace: ${String(knowledge.workspaceRoot ?? 'not recorded')}`
        : 'Scope: profile',
      ...(typeof knowledge.sourceRunId === 'string'
        ? [`Source run: ${knowledge.sourceRunId}`]
        : []),
      ...(typeof knowledge.sourceQuote === 'string' && knowledge.sourceQuote
        ? [`Source quote: ${knowledge.sourceQuote}`]
        : []),
      ...(Array.isArray(knowledge.evidenceCallIds) && knowledge.evidenceCallIds.length
        ? [`Evidence calls: ${knowledge.evidenceCallIds.slice(0, 8).map(String).join(', ')}`]
        : []),
      `Index: ${entry.value.hasEmbedding ? 'semantic' : 'lexical'}`,
      `ID: ${value.id}`,
    ];
    if (automatic) {
      if (knowledge.state === 'active')
        items.push(
          actionItem(
            { resource: 'memory', id: value.id, action: 'revert' },
            'Undo learning · retain history',
          ),
        );
    } else
      items.push(
        actionItem({ resource: 'memory', id: value.id, action: 'delete' }, 'Delete memory'),
      );
  } else if (kind === 'schedules') {
    const schedule = entry.value;
    title = schedule.name;
    detail = [
      `${schedule.enabled ? 'Enabled' : 'Paused'} · ${schedule.type ?? 'unknown'} · ${schedule.expression ?? ''}`,
      schedule.agentInput ?? '',
      `Next run: ${schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : 'not scheduled'}`,
    ];
    items.push(
      actionItem(
        { resource: kind, id: value.id, action: schedule.enabled ? 'pause' : 'resume' },
        schedule.enabled ? 'Pause automation' : 'Resume automation',
      ),
      actionItem({ resource: kind, id: value.id, action: 'edit' }, 'Edit automation'),
      actionItem(
        { resource: kind, id: value.id, action: 'trigger' },
        'Run now · requires confirmation',
      ),
      actionItem({ resource: kind, id: value.id, action: 'delete' }, 'Delete automation'),
    );
  } else {
    title = `Task · ${value.id}`;
    detail = [
      `${entry.value.kind} · ${entry.value.status}`,
      `Schedule: ${entry.value.scheduleId ?? 'none'}`,
    ];
    if (['queued', 'running', 'paused'].includes(entry.value.status))
      items.push(actionItem({ resource: kind, id: value.id, action: 'cancel' }, 'Cancel task'));
  }
  return { title, items, detail, query: '', index: 0 };
}

export function confirmationMenu(action: ManagementAction): PickerState {
  const deleting = action.action === 'delete';
  return {
    title: deleting ? 'Confirm deletion' : `Confirm ${action.action}`,
    query: '',
    index: 0,
    detail: [
      `${action.resource} · ${action.id}`,
      deleting
        ? 'This permanently removes the selected record and its owned history.'
        : 'This changes runtime state. Review the target before continuing.',
    ],
    items: [
      { id: 'dismiss', label: 'Back · keep unchanged' },
      {
        id: `confirmed:${JSON.stringify(action)}`,
        label: deleting ? 'Delete permanently' : `Confirm ${action.action}`,
      },
    ],
  };
}

export function managementRequest(action: ManagementAction): {
  path: string;
  method: 'POST' | 'DELETE';
} {
  if (action.action === 'edit') throw new Error('Editing requires a schedule draft');
  const path = `/api/${action.resource}/${encodeURIComponent(action.id)}`;
  return action.action === 'delete'
    ? { path, method: 'DELETE' }
    : { path: `${path}/${action.action}`, method: 'POST' };
}
