import { randomUUID } from 'node:crypto';

import { redactValue } from '../security/redaction.js';

export const eventTypes = [
  'session.created',
  'session.resumed',
  'session.closed',
  'thread.created',
  'message.created',
  'run.created',
  'run.queued',
  'run.started',
  'run.paused',
  'run.resumed',
  'run.cancel_requested',
  'run.cancelled',
  'run.completed',
  'run.failed',
  'model.started',
  'model.delta',
  'model.completed',
  'capabilities.assembled',
  'prompt.assembled',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'memory.stored',
  'memory.retrieved',
  'task.queued',
  'task.started',
  'task.paused',
  'task.resumed',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.retried',
  'schedule.created',
  'schedule.updated',
  'schedule.paused',
  'schedule.triggered',
  'plugin.loaded',
  'plugin.unloaded',
  'skill.loaded',
  'skill.failed',
  'skill.learned',
  'provider.connected',
  'provider.unavailable',
] as const;

export type EventType = (typeof eventTypes)[number];

export interface EventRecord {
  id?: number;
  eventId: string;
  schemaVersion: 1;
  type: EventType;
  source: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  taskId?: string;
  correlationId: string;
  createdAt: number;
  payload: Record<string, unknown>;
}

export function createEvent(
  type: EventType,
  payload: Record<string, unknown> = {},
  context: Partial<
    Pick<EventRecord, 'sessionId' | 'threadId' | 'runId' | 'taskId' | 'correlationId' | 'source'>
  > = {},
): EventRecord {
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    type,
    source: context.source ?? 'daemon',
    correlationId: context.correlationId ?? randomUUID(),
    createdAt: Date.now(),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.threadId ? { threadId: context.threadId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.taskId ? { taskId: context.taskId } : {}),
    payload: redactValue(payload) as Record<string, unknown>,
  };
}
