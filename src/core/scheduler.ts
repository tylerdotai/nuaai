import { randomUUID } from 'node:crypto';

import type { DatabaseStore, TaskRow } from '../memory/db.js';
import type { EventType } from './events.js';

export type ScheduleType = 'once' | 'interval' | 'cron' | 'manual' | 'startup';
export type MissedRunPolicy = 'run_once' | 'skip';
export interface SchedulePolicy {
  missedRun: MissedRunPolicy;
  maxAttempts: number;
  retryDelayMs: number;
  concurrencyLimit: number;
}
export interface ScheduleInput {
  name: string;
  type: ScheduleType;
  expression: string;
  agentInput: string;
  enabled?: boolean;
  policy?: Partial<SchedulePolicy>;
}
export interface Schedule {
  id: string;
  name: string;
  type: ScheduleType;
  expression: string;
  agentInput: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  policy: SchedulePolicy;
}
export type SchedulerEvent = (
  type: EventType,
  payload: Record<string, unknown>,
  context?: Record<string, string>,
) => void;

const defaultSchedulePolicy: SchedulePolicy = {
  missedRun: 'run_once',
  maxAttempts: 1,
  retryDelayMs: 1_000,
  concurrencyLimit: 1,
};

function normalizePolicy(value: unknown): SchedulePolicy {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const positiveInt = (candidate: unknown, fallback: number): number =>
    typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 1
      ? candidate
      : fallback;
  const nonNegativeInt = (candidate: unknown, fallback: number): number =>
    typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0
      ? candidate
      : fallback;
  return {
    missedRun: input.missedRun === 'skip' ? 'skip' : defaultSchedulePolicy.missedRun,
    maxAttempts: positiveInt(input.maxAttempts, defaultSchedulePolicy.maxAttempts),
    retryDelayMs: nonNegativeInt(input.retryDelayMs, defaultSchedulePolicy.retryDelayMs),
    concurrencyLimit: positiveInt(input.concurrencyLimit, defaultSchedulePolicy.concurrencyLimit),
  };
}

function parsePersistedPolicy(value: unknown): SchedulePolicy {
  if (typeof value !== 'string') return normalizePolicy(value);
  try {
    return normalizePolicy(JSON.parse(value) as unknown);
  } catch {
    return normalizePolicy(undefined);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseInterval(expression: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(expression.trim());
  if (!match) throw new Error(`Invalid interval expression: ${expression}`);
  const count = Number(match[1]);
  const multiplier = (
    { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>
  )[(match[2] ?? 'ms').toLowerCase()];
  return count * multiplier;
}

export function nextCronRun(expression: string, now = Date.now()): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron expression must have five fields');
  const minute = fields[0];
  const interval = /^\*\/(\d+)$/.exec(minute)?.[1];
  const date = new Date(now);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  for (let count = 0; count < 24 * 60 * 366; count += 1) {
    const matchesMinute =
      minute === '*' ||
      (interval
        ? date.getMinutes() % Number(interval) === 0
        : date.getMinutes() === Number(minute));
    const matchesHour = fields[1] === '*' || date.getHours() === Number(fields[1]);
    const matchesDay = fields[2] === '*' || date.getDate() === Number(fields[2]);
    const matchesMonth = fields[3] === '*' || date.getMonth() + 1 === Number(fields[3]);
    const matchesWeekday = fields[4] === '*' || date.getDay() === Number(fields[4]);
    if (matchesMinute && matchesHour && matchesDay && matchesMonth && matchesWeekday)
      return date.getTime();
    date.setMinutes(date.getMinutes() + 1);
  }
  throw new Error(`Cron expression has no upcoming occurrence: ${expression}`);
}

function nextRun(type: ScheduleType, expression: string, now: number): number | null {
  if (type === 'manual') return null;
  if (type === 'startup') return now;
  if (type === 'once') {
    const value = Number(expression);
    if (!Number.isFinite(value)) throw new Error('One-shot expression must be an epoch timestamp');
    return value;
  }
  if (type === 'interval') return now + parseInterval(expression);
  return nextCronRun(expression, now);
}

// biome-ignore lint/suspicious/noConfusingVoidType: observation-only callbacks intentionally return void.
type ScheduleRunResult = void | { status: string; output?: string };

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly running = new Map<string, number>();
  constructor(
    private readonly store: DatabaseStore,
    private readonly onEvent: SchedulerEvent,
    private readonly onRun: (schedule: Schedule, taskId: string) => Promise<ScheduleRunResult>,
    private readonly onCancel?: (taskId: string) => void,
  ) {}

  create(input: ScheduleInput, now = Date.now()): Schedule {
    if (!input.name.trim() || !input.agentInput.trim())
      throw new Error('Schedule name and agent input are required');
    const schedule: Schedule = {
      id: randomUUID(),
      name: input.name,
      type: input.type,
      expression: input.expression,
      agentInput: input.agentInput,
      enabled: input.enabled ?? true,
      nextRunAt: input.enabled === false ? null : nextRun(input.type, input.expression, now),
      lastRunAt: null,
      policy: normalizePolicy(input.policy),
    };
    this.store.saveSchedule(schedule, now);
    this.onEvent(
      'schedule.created',
      { name: schedule.name, type: schedule.type },
      { taskId: schedule.id },
    );
    return schedule;
  }

  list(): Schedule[] {
    return this.store.listSchedules().map((value) => ({
      id: String(value.id),
      name: String(value.name),
      type: String(value.type) as ScheduleType,
      expression: String(value.expression),
      agentInput: String(value.agentInput),
      enabled: Boolean(value.enabled),
      nextRunAt: value.nextRunAt === null ? null : Number(value.nextRunAt),
      lastRunAt: value.lastRunAt === null ? null : Number(value.lastRunAt),
      policy: parsePersistedPolicy(value.policy),
    }));
  }
  start(): void {
    if (this.timer) return;
    this.recoverInterruptedTasks();
    this.timer = setInterval(() => void this.poll(), 1_000);
    void this.poll();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async trigger(id: string): Promise<void> {
    const schedule = this.list().find((entry) => entry.id === id);
    if (!schedule) throw new Error(`Unknown schedule: ${id}`);
    await this.runSchedule(schedule);
  }
  pause(id: string): void {
    this.store.updateSchedule(id, { enabled: false, nextRunAt: null });
    this.onEvent('schedule.paused', {}, { taskId: id });
  }
  update(id: string, input: Partial<ScheduleInput>): Schedule {
    const current = this.list().find((entry) => entry.id === id);
    if (!current) throw new Error(`Unknown schedule: ${id}`);
    const next: ScheduleInput = {
      name: input.name ?? current.name,
      type: input.type ?? current.type,
      expression: input.expression ?? current.expression,
      agentInput: input.agentInput ?? current.agentInput,
      enabled: input.enabled ?? current.enabled,
      policy: { ...current.policy, ...input.policy },
    };
    if (!next.name.trim() || !next.agentInput.trim())
      throw new Error('Schedule name and agent input are required');
    const updated: Schedule = {
      ...current,
      ...next,
      nextRunAt: next.enabled ? nextRun(next.type, next.expression, Date.now()) : null,
      policy: normalizePolicy(next.policy),
    };
    this.store.saveSchedule(updated);
    this.onEvent('schedule.updated', { name: updated.name, type: updated.type }, { taskId: id });
    return updated;
  }
  resume(id: string, now = Date.now()): void {
    const schedule = this.list().find((entry) => entry.id === id);
    if (!schedule) throw new Error(`Unknown schedule: ${id}`);
    this.store.updateSchedule(id, {
      enabled: true,
      nextRunAt: nextRun(schedule.type, schedule.expression, now),
    });
    this.onEvent('schedule.updated', { enabled: true }, { taskId: id });
  }

  listTasks() {
    return this.store.listTasks();
  }

  createTask(agentInput: string, name = 'Background task'): TaskRow {
    if (!agentInput.trim()) throw new Error('Background task input is required');
    const task = this.store.createTask(
      'background.run',
      {
        name: name.trim() || 'Background task',
        agentInput,
        attempts: 0,
        maxAttempts: defaultSchedulePolicy.maxAttempts,
        retryDelayMs: defaultSchedulePolicy.retryDelayMs,
      },
      null,
    );
    const pseudoSchedule: Schedule = {
      id: `task:${task.id}`,
      name: name.trim() || 'Background task',
      type: 'manual',
      expression: '',
      agentInput,
      enabled: false,
      nextRunAt: null,
      lastRunAt: null,
      policy: defaultSchedulePolicy,
    };
    this.onEvent('task.queued', { kind: task.kind }, { taskId: task.id });
    void this.executeTask(task, pseudoSchedule);
    return task;
  }

  cancelTask(id: string): void {
    const task = this.store.listTasks().find((entry) => entry.id === id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (!['queued', 'running'].includes(task.status))
      throw new Error(`Task ${id} is not cancellable`);
    this.store.updateTask(id, 'cancelled', {
      ...task.payload,
      error: 'Task cancelled',
    });
    this.onCancel?.(id);
    this.onEvent('task.cancelled', { kind: task.kind, error: 'Task cancelled' }, { taskId: id });
  }

  private recoverInterruptedTasks(): void {
    const now = Date.now();
    const schedules = new Map(this.list().map((schedule) => [schedule.id, schedule]));
    for (const task of this.store.listTasks()) {
      if (!['queued', 'running'].includes(task.status)) continue;
      this.store.updateTask(task.id, 'failed', {
        ...task.payload,
        error: 'Task interrupted by daemon restart',
        recoveredAt: now,
      });
      this.onEvent(
        'task.failed',
        { kind: task.kind, error: 'Task interrupted by daemon restart', recovered: true },
        { taskId: task.id },
      );
      const schedule = task.scheduleId ? schedules.get(task.scheduleId) : undefined;
      if (schedule?.enabled)
        this.store.updateSchedule(schedule.id, {
          nextRunAt: now,
        });
    }
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    for (const schedule of this.list()) {
      if (!schedule.enabled || schedule.nextRunAt === null || schedule.nextRunAt > now) continue;
      if (schedule.policy.missedRun === 'skip' && schedule.nextRunAt < now) {
        const next =
          schedule.type === 'once' || schedule.type === 'startup'
            ? null
            : nextRun(schedule.type, schedule.expression, now);
        this.store.updateSchedule(schedule.id, {
          enabled: next !== null,
          nextRunAt: next,
        });
        this.onEvent(
          'schedule.updated',
          { missedRun: 'skipped', previousRunAt: schedule.nextRunAt },
          { taskId: schedule.id },
        );
        continue;
      }
      await this.runSchedule(schedule);
    }
  }

  private async runSchedule(schedule: Schedule): Promise<void> {
    const active = this.running.get(schedule.id) ?? 0;
    if (active >= schedule.policy.concurrencyLimit) return;
    const now = Date.now();
    const next =
      schedule.type === 'once' || schedule.type === 'startup'
        ? null
        : nextRun(schedule.type, schedule.expression, now);
    this.store.updateSchedule(schedule.id, { lastRunAt: now, nextRunAt: next });
    const task = this.store.createTask(
      'schedule.run',
      {
        name: schedule.name,
        agentInput: schedule.agentInput,
        attempts: 0,
        maxAttempts: schedule.policy.maxAttempts,
        retryDelayMs: schedule.policy.retryDelayMs,
      },
      schedule.id,
      now,
    );
    this.onEvent('task.queued', { kind: task.kind }, { taskId: task.id });
    this.onEvent(
      'schedule.triggered',
      { name: schedule.name, agentInput: schedule.agentInput },
      { taskId: schedule.id },
    );
    await this.executeTask(task, { ...schedule, lastRunAt: now, nextRunAt: next });
  }

  private async executeTask(task: TaskRow, schedule: Schedule): Promise<void> {
    const active = this.running.get(schedule.id) ?? 0;
    if (active >= schedule.policy.concurrencyLimit) return;
    this.running.set(schedule.id, active + 1);
    let taskPayload = { ...task.payload };
    try {
      this.store.updateTask(task.id, 'running', taskPayload);
      this.onEvent('task.started', { kind: task.kind }, { taskId: task.id });
      let attempt = 0;
      while (attempt < schedule.policy.maxAttempts) {
        const current = this.store.listTasks().find((entry) => entry.id === task.id);
        if (current?.status === 'cancelled') return;
        attempt += 1;
        taskPayload = { ...taskPayload, attempts: attempt };
        this.store.updateTask(task.id, 'running', taskPayload);
        try {
          const outcome = await this.onRun(schedule, task.id);
          if (outcome && outcome.status !== 'completed')
            throw new Error(`Agent run ended with status: ${outcome.status}`);
          const completed = this.store.listTasks().find((entry) => entry.id === task.id);
          if (completed?.status !== 'cancelled') {
            this.store.updateTask(task.id, 'completed', taskPayload);
            this.onEvent(
              'task.completed',
              { kind: task.kind, attempts: attempt },
              { taskId: task.id },
            );
          }
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          taskPayload = { ...taskPayload, lastError: message };
          if (attempt >= schedule.policy.maxAttempts) throw error;
          this.store.updateTask(task.id, 'queued', taskPayload);
          this.onEvent(
            'task.retried',
            {
              kind: task.kind,
              attempt,
              nextAttempt: attempt + 1,
              error: message,
            },
            { taskId: task.id },
          );
          await sleep(schedule.policy.retryDelayMs * 2 ** (attempt - 1));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.store.listTasks().find((entry) => entry.id === task.id);
      if (current?.status !== 'cancelled') {
        this.store.updateTask(task.id, 'failed', { ...taskPayload, error: message });
        this.onEvent('task.failed', { kind: task.kind, error: message }, { taskId: task.id });
      }
    } finally {
      const remaining = (this.running.get(schedule.id) ?? 1) - 1;
      if (remaining > 0) this.running.set(schedule.id, remaining);
      else this.running.delete(schedule.id);
    }
  }
}
