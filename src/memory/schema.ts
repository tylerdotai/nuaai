import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  title: text('title').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  provider: text('provider'),
  model: text('model'),
  createdAt: integer('created_at').notNull(),
});

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: text('event_id').notNull().unique(),
  schemaVersion: integer('schema_version').notNull(),
  type: text('type').notNull(),
  source: text('source').notNull(),
  sessionId: text('session_id'),
  threadId: text('thread_id'),
  runId: text('run_id'),
  taskId: text('task_id'),
  correlationId: text('correlation_id').notNull(),
  createdAt: integer('created_at').notNull(),
  payload: text('payload').notNull(),
});

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull(),
  status: text('status').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  input: text('input').notNull(),
  output: text('output').notNull().default(''),
  cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  correlationId: text('correlation_id').notNull(),
});

export const approvalRequests = sqliteTable('approval_requests', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  threadId: text('thread_id').notNull(),
  sessionId: text('session_id'),
  toolCallId: text('tool_call_id').notNull(),
  toolName: text('tool_name').notNull(),
  argumentsPreview: text('arguments_preview').notNull(),
  payloadHash: text('payload_hash').notNull(),
  requiredPermission: text('required_permission').notNull(),
  permissionSource: text('permission_source').notNull(),
  risk: text('risk').notNull(),
  target: text('target').notNull(),
  providerOwned: integer('provider_owned', { mode: 'boolean' }).notNull().default(false),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  decidedAt: integer('decided_at'),
  executionStartedAt: integer('execution_started_at'),
  executionCompletedAt: integer('execution_completed_at'),
  resultHash: text('result_hash'),
  resultPreview: text('result_preview'),
  executionError: text('execution_error'),
});

export const memories = sqliteTable('memory_records', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
  metadata: text('metadata').notNull(),
  embedding: blob('embedding'),
  embeddingDimensions: integer('embedding_dimensions'),
  createdAt: integer('created_at').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  payload: text('payload').notNull(),
  scheduleId: text('schedule_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  expression: text('expression').notNull(),
  agentInput: text('agent_input').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  nextRunAt: integer('next_run_at'),
  lastRunAt: integer('last_run_at'),
  policy: text('policy').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const skills = sqliteTable('skills', {
  name: text('name').primaryKey(),
  description: text('description').notNull(),
  version: text('version').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  source: text('source').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const plugins = sqliteTable('plugins', {
  name: text('name').primaryKey(),
  version: text('version').notNull(),
  apiVersion: text('api_version').notNull().default('1'),
  entry: text('entry').notNull().default('index.mjs'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  capabilities: text('capabilities').notNull(),
  dependencies: text('dependencies').notNull().default('{}'),
  config: text('config').notNull().default('{}'),
  source: text('source').notNull(),
  lastError: text('last_error'),
  updatedAt: integer('updated_at').notNull(),
});
