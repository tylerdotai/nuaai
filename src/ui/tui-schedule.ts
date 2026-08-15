import type { ScheduleType } from '../core/scheduler.js';

export interface TuiScheduleDraft {
  id?: string;
  name: string;
  type: ScheduleType;
  expression: string;
  agentInput: string;
  enabled: boolean;
}

const scheduleTypes = new Set<ScheduleType>(['once', 'interval', 'cron', 'manual', 'startup']);

export function parseScheduleCommand(value: string, mode: 'create' | 'edit'): TuiScheduleDraft {
  const parts = value.split('|').map((part) => part.trim());
  const expected = mode === 'create' ? 4 : 5;
  if (parts.length !== expected)
    throw new Error(
      mode === 'create'
        ? 'Create format: name|type|expression|agent input'
        : 'Edit format: id|name|type|expression|agent input',
    );
  const offset = mode === 'create' ? 0 : 1;
  const id = mode === 'edit' ? parts[0] : undefined;
  const name = parts[offset];
  const type = parts[offset + 1] as ScheduleType;
  const expression = parts[offset + 2];
  const agentInput = parts[offset + 3];
  if (!name) throw new Error('Schedule name is required');
  if (!scheduleTypes.has(type)) throw new Error(`Unsupported schedule type: ${type}`);
  if (!expression) throw new Error('Schedule expression is required');
  if (!agentInput) throw new Error('Schedule agent input is required');
  if (mode === 'edit' && !id) throw new Error('Schedule id is required');
  return { ...(id ? { id } : {}), name, type, expression, agentInput, enabled: true };
}
