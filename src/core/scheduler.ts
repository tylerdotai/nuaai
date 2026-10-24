import { randomUUID } from 'node:crypto';

import type { DatabaseStore, TaskRow } from '../memory/db.js';
import { redactText } from '../security/redaction.js';
import { publicApprovalRequest } from './approvals.js';
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
export interface TaskRunReference {
  runId: string;
  threadId: string;
  sessionId: string;
  correlationId: string;
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = new Map<string, number>();
  private nativeRunning = new Map<string, Promise<void>>();
  private internalHandlers = new Map<
    string,
    (task: TaskRow, signal: AbortSignal) => Promise<void>
  >();
  private internalRunning = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();

  registerInternalHandler(
    kind: string,
    handler: (task: TaskRow, signal: AbortSignal) => Promise<void>,
  ): void {
    if (this.internalHandlers.has(kind))
      throw new Error(`Internal task handler already registered: ${kind}`);
    this.internalHandlers.set(kind, handler);
  }

  wake(): void {
    if (this.timer) void this.poll();
  }

  private launchInternal(task: TaskRow): void {
    const handler = this.internalHandlers.get(task.kind);
    if (!handler || this.internalRunning.has(task.id)) return;
    const controller = new AbortController();
    this.store.updateTask(task.id, 'running', {
      ...task.payload,
      attempts: Number(task.payload.attempts ?? 0) + 1,
    });
    const promise = Promise.resolve()
      .then(() => handler(task, controller.signal))
      .then(() => {
        if (this.store.getTask(task.id)?.status === 'cancelled') return;
        this.store.updateTask(task.id, 'completed');
        this.onEvent('task.completed', { kind: task.kind, internal: true }, { taskId: task.id });
      })
      .catch((error: unknown) => {
        if (this.store.getTask(task.id)?.status === 'cancelled') return;
        const state = this.store.getTask(task.id);
        const retry =
          controller.signal.aborted && !this.timer && Number(state?.payload.attempts ?? 0) < 2;
        this.store.updateTask(task.id, retry ? 'queued' : 'failed', {
          ...state?.payload,
          error: redactText(error instanceof Error ? error.message : String(error)),
        });
        this.onEvent(
          retry ? 'task.queued' : 'task.failed',
          { kind: task.kind, internal: true },
          { taskId: task.id },
        );
      })
      .finally(() => {
        this.internalRunning.delete(task.id);
        if (this.timer) this.wake();
      });
    this.internalRunning.set(task.id, { controller, promise });
  }
  constructor(
    private readonly store: DatabaseStore,
    private readonly onEvent: SchedulerEvent,
    private readonly onRun: (
      schedule: Schedule,
      taskId: string,
      linked: (run: TaskRunReference) => void,
    ) => Promise<ScheduleRunResult>,
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
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const active of this.internalRunning.values())
      active.controller.abort(new Error('Daemon stopping; internal work retained for recovery'));
    await Promise.all([...this.internalRunning.values()].map((active) => active.promise));
  }
  async drain(): Promise<void> {
    await Promise.all([...this.nativeRunning.values()]);
  }

  private trackTask(task: TaskRow, schedule: Schedule): Promise<void> {
    const execution = this.executeTask(task, schedule).finally(() =>
      this.nativeRunning.delete(task.id),
    );
    this.nativeRunning.set(task.id, execution);
    return execution;
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
  deleteSchedule(id: string): void {
    const schedule = this.list().find((entry) => entry.id === id);
    if (!schedule) throw new Error(`Unknown schedule: ${id}`);
    this.store.deleteSchedule(id);
    this.running.delete(id);
  }

  listTasks() {
    return this.store.listTasks();
  }

  inspectTask(id: string) {
    const task = this.store.getTask(id);
    if (!task) return undefined;
    const ref = task.payload.execution as Partial<TaskRunReference> | undefined;
    let execution: TaskRunReference | undefined =
      ref &&
      typeof ref.runId === 'string' &&
      typeof ref.threadId === 'string' &&
      typeof ref.sessionId === 'string' &&
      typeof ref.correlationId === 'string'
        ? {
            runId: ref.runId,
            threadId: ref.threadId,
            sessionId: ref.sessionId,
            correlationId: ref.correlationId,
          }
        : undefined;
    let linkage = execution ? 'recorded' : 'unavailable';
    if (!execution && !task.payload.execution) {
      const candidates = this.store.legacyBackgroundRunCandidates(task);
      if (candidates.length === 1) {
        const candidate = candidates[0];
        const thread = this.store.getThread(candidate.threadId);
        if (thread) {
          execution = {
            runId: candidate.id,
            threadId: candidate.threadId,
            sessionId: thread.sessionId,
            correlationId: candidate.correlationId,
          };
          linkage = 'legacy_unique_task_session';
        }
      } else if (candidates.length > 1) linkage = 'ambiguous';
    }
    const candidate = execution ? this.store.getRun(execution.runId) : undefined;
    const run =
      candidate &&
      candidate.threadId === execution?.threadId &&
      candidate.correlationId === execution.correlationId &&
      this.store.getThread(candidate.threadId)?.sessionId === execution.sessionId
        ? candidate
        : undefined;
    const events = run
      ? this.store
          .listRecentEventsForRun(run.id, 100)
          .filter((event) =>
            [
              'run.failed',
              'run.cancelled',
              'run.paused',
              'tool.failed',
              'approval.failed',
              'approval.denied',
              'capabilities.assembled',
            ].includes(event.type),
          )
          .map((event) => ({
            id: event.id,
            type: event.type,
            ...(typeof event.payload.reason === 'string'
              ? { reason: redactText(event.payload.reason).slice(0, 500) }
              : {}),
            ...(typeof event.payload.approvalId === 'string'
              ? { approvalId: event.payload.approvalId }
              : {}),
            ...(typeof event.payload.name === 'string' ? { tool: event.payload.name } : {}),
            ...(typeof event.payload.error === 'string'
              ? { error: redactText(event.payload.error).slice(0, 8000) }
              : {}),
            ...(typeof event.payload.verificationPolicy === 'string'
              ? { verificationPolicy: event.payload.verificationPolicy }
              : {}),
          }))
      : [];
    const pausedEvent =
      run?.status === 'paused'
        ? [...events].reverse().find((event) => event.type === 'run.paused')
        : undefined;
    const pendingApproval = pausedEvent?.approvalId
      ? this.store.getApprovalRequest(pausedEvent.approvalId)
      : undefined;
    const pause =
      run?.status === 'paused'
        ? {
            reason: pausedEvent?.reason ?? 'unknown',
            ...(pausedEvent ? { eventId: pausedEvent.id } : {}),
            ...(pendingApproval?.runId === run.id
              ? { approval: publicApprovalRequest(pendingApproval) }
              : {}),
            review: {
              sessionId: execution?.sessionId,
              threadId: run.threadId,
              instruction:
                'Open the child conversation and review the pending action card; task inspection does not authorize it.',
            },
          }
        : undefined;
    const terminal = [...events]
      .reverse()
      .find((event) => ['run.failed', 'run.cancelled'].includes(event.type));
    const message =
      terminal?.error ??
      (task.status === 'failed' && typeof task.payload.error === 'string'
        ? redactText(task.payload.error).slice(0, 8000)
        : undefined);
    return {
      found: true,
      task: {
        id: task.id,
        kind: task.kind,
        status: task.status,
        attempts: task.payload.attempts ?? 0,
      },
      linkage: run || linkage === 'ambiguous' ? linkage : 'unavailable',
      execution,
      ...(run
        ? { run: { id: run.id, status: run.status, provider: run.provider, model: run.model } }
        : {}),
      ...(message
        ? {
            failure: {
              message,
              source: terminal?.type ?? 'task',
              ...(terminal ? { eventId: terminal.id } : {}),
            },
          }
        : {}),
      ...(pause ? { pause } : {}),
      events,
    };
  }

  createTask(agentInput: string, name = 'Background task', parentRunId?: string): TaskRow {
    if (!agentInput.trim()) throw new Error('Background task input is required');
    if (parentRunId && !this.store.getRunExecutionContext(parentRunId)?.identitySnapshotId)
      throw new Error('Native parent execution identity is unavailable.');
    const task = this.store.createTask(
      'background.run',
      {
        name: name.trim() || 'Background task',
        agentInput,
        ...(parentRunId ? { parentRunId } : {}),
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
    void this.trackTask(task, pseudoSchedule).catch((error) =>
      console.error('NUAAI native task finalization failed', {
        taskId: task.id,
        error: redactText(error instanceof Error ? error.message : String(error)),
      }),
    );
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
    this.internalRunning.get(id)?.controller.abort(new Error('Task cancelled'));
    this.onCancel?.(id);
    this.onEvent('task.cancelled', { kind: task.kind, error: 'Task cancelled' }, { taskId: id });
  }

  private recoverInterruptedTasks(): void {
    const now = Date.now();
    const schedules = new Map(this.list().map((schedule) => [schedule.id, schedule]));
    for (const task of this.store.listTasks()) {
      if (!['queued', 'running'].includes(task.status)) continue;
      if (this.internalHandlers.has(task.kind)) {
        if (task.status === 'running')
          this.store.updateTask(
            task.id,
            Number(task.payload.attempts ?? 0) < 2 ? 'queued' : 'failed',
            { ...task.payload, recovery: 'Internal review interrupted by restart' },
          );
        continue;
      }
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
    for (const kind of this.internalHandlers.keys()) {
      if ([...this.internalRunning.keys()].some((id) => this.store.getTask(id)?.kind === kind))
        continue;
      const task = this.store.queuedTasks(kind, 1)[0];
      if (task) this.launchInternal(task);
    }
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
    await this.trackTask(task, { ...schedule, lastRunAt: now, nextRunAt: next });
  }

  private async executeTask(task: TaskRow, schedule: Schedule): Promise<void> {
    const active = this.running.get(schedule.id) ?? 0;
    if (active >= schedule.policy.concurrencyLimit) return;
    this.running.set(schedule.id, active + 1);
    let taskPayload = { ...task.payload };
    let execution: TaskRunReference | undefined;
    const context = () => ({
      taskId: task.id,
      ...(execution ? { correlationId: execution.correlationId } : {}),
    });
    try {
      this.store.updateTask(task.id, 'running', taskPayload);
      this.onEvent('task.started', { kind: task.kind }, context());
      let attempt = 0;
      while (attempt < schedule.policy.maxAttempts) {
        const current = this.store.listTasks().find((entry) => entry.id === task.id);
        if (current?.status === 'cancelled') return;
        attempt += 1;
        taskPayload = { ...taskPayload, attempts: attempt };
        this.store.updateTask(task.id, 'running', taskPayload);
        try {
          const outcome = await this.onRun(schedule, task.id, (linked) => {
            execution = linked;
            taskPayload = { ...taskPayload, execution: linked };
            this.store.updateTask(task.id, 'running', taskPayload);
            this.onEvent('task.run.linked', { ...linked, attempt }, context());
          });
          if (outcome && outcome.status !== 'completed')
            throw new Error(
              outcome.output?.trim()
                ? redactText(outcome.output).slice(0, 8000)
                : `Agent run ended with status: ${outcome.status}`,
            );
          const completed = this.store.listTasks().find((entry) => entry.id === task.id);
          if (completed?.status !== 'cancelled') {
            this.store.updateTask(task.id, 'completed', taskPayload);
            this.onEvent(
              'task.completed',
              { kind: task.kind, attempts: attempt, execution },
              context(),
            );
          }
          return;
        } catch (error) {
          const message = redactText(error instanceof Error ? error.message : String(error)).slice(
            0,
            8000,
          );
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
            context(),
          );
          await sleep(schedule.policy.retryDelayMs * 2 ** (attempt - 1));
        }
      }
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error)).slice(
        0,
        8000,
      );
      const current = this.store.listTasks().find((entry) => entry.id === task.id);
      if (current?.status !== 'cancelled') {
        this.store.updateTask(task.id, 'failed', { ...taskPayload, error: message });
        this.onEvent('task.failed', { kind: task.kind, error: message, execution }, context());
      }
    } finally {
      const remaining = (this.running.get(schedule.id) ?? 1) - 1;
      if (remaining > 0) this.running.set(schedule.id, remaining);
      else this.running.delete(schedule.id);
    }
  }
}
