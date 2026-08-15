import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';

import { workspaceDirectory } from '../config/index.js';
import type { EventRecord } from '../core/events.js';
import { redactValue } from '../security/redaction.js';

export type MemoryDatabase = Database.Database;

export type DrizzleDatabase = ReturnType<typeof drizzle>;

export interface AppDatabase {
  raw: MemoryDatabase;
  orm: DrizzleDatabase;
  root: string;
}

export interface MemoryRow {
  id: number;
  content: string;
  createdAt: number;
}

export interface SessionRow {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadRow {
  id: string;
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRow {
  id: string;
  threadId: string;
  role: string;
  content: string;
  provider: string | null;
  model: string | null;
  createdAt: number;
}

export interface RunRow {
  id: string;
  threadId: string;
  status: string;
  provider: string;
  model: string;
  input: string;
  output: string;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  correlationId: string;
}

export interface TaskRow {
  id: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  scheduleId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PluginRow {
  name: string;
  version: string;
  apiVersion: string;
  entry: string;
  enabled: boolean;
  capabilities: string[];
  dependencies: Record<string, string>;
  config: Record<string, unknown>;
  source: string;
  lastError: string | null;
  updatedAt: number;
}

function createSchema(db: MemoryDatabase, vector = false): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT NOT NULL DEFAULT '',
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      correlation_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT,
      thread_id TEXT,
      run_id TEXT,
      task_id TEXT,
      correlation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_records (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL,
      embedding BLOB,
      embedding_dimensions INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      schedule_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      expression TEXT NOT NULL,
      agent_input TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER,
      last_run_at INTEGER,
      policy TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plugins (
      name TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      api_version TEXT NOT NULL DEFAULT '1',
      entry TEXT NOT NULL DEFAULT 'index.mjs',
      enabled INTEGER NOT NULL DEFAULT 1,
      capabilities TEXT NOT NULL,
      dependencies TEXT NOT NULL DEFAULT '{}',
      config TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_created_at_idx ON events(created_at, id);
    CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS runs_thread_idx ON runs(thread_id, created_at);
    CREATE TABLE IF NOT EXISTS memory_vector_refs (
      memory_id TEXT PRIMARY KEY,
      vector_rowid INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');
  `);
  const scheduleColumns = db.prepare('PRAGMA table_info(schedules)').all() as Array<{
    name: string;
  }>;
  if (!scheduleColumns.some((column) => column.name === 'policy'))
    db.exec("ALTER TABLE schedules ADD COLUMN policy TEXT NOT NULL DEFAULT '{}'");
  const pluginColumns = db.prepare('PRAGMA table_info(plugins)').all() as Array<{ name: string }>;
  const pluginMigrations: Array<[string, string]> = [
    ['api_version', "ALTER TABLE plugins ADD COLUMN api_version TEXT NOT NULL DEFAULT '1'"],
    ['entry', "ALTER TABLE plugins ADD COLUMN entry TEXT NOT NULL DEFAULT 'index.mjs'"],
    ['dependencies', "ALTER TABLE plugins ADD COLUMN dependencies TEXT NOT NULL DEFAULT '{}'"],
    ['config', "ALTER TABLE plugins ADD COLUMN config TEXT NOT NULL DEFAULT '{}'"],
    ['last_error', 'ALTER TABLE plugins ADD COLUMN last_error TEXT'],
  ];
  for (const [name, migration] of pluginMigrations)
    if (!pluginColumns.some((column) => column.name === name)) db.exec(migration);
  db.prepare("UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'").run();
  if (vector) {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(embedding float[768]);');
  }
}

function openRaw(root: string, loadVector = false): MemoryDatabase {
  const directory = workspaceDirectory(root);
  mkdirSync(directory, { recursive: true });
  const db = new Database(join(directory, 'memory.db'));
  db.pragma('journal_mode = WAL');
  if (loadVector) loadSqliteVec(db);
  createSchema(db, loadVector);
  return db;
}

export function openMemoryDatabase(root = process.cwd()): MemoryDatabase {
  return openRaw(resolve(root));
}

export function openAppDatabase(root = process.cwd()): AppDatabase {
  const resolvedRoot = resolve(root);
  const raw = openRaw(resolvedRoot, true);
  return { raw, orm: drizzle(raw), root: resolvedRoot };
}

export function addMemory(db: MemoryDatabase, content: string, createdAt = Date.now()): number {
  if (!content.trim()) throw new Error('Memory content is required');
  const result = db
    .prepare('INSERT INTO memories (content, created_at) VALUES (?, ?)')
    .run(content, createdAt);
  return Number(result.lastInsertRowid);
}

export function listMemories(db: MemoryDatabase): MemoryRow[] {
  return db
    .prepare('SELECT id, content, created_at AS createdAt FROM memories ORDER BY id ASC')
    .all() as MemoryRow[];
}

export class DatabaseStore {
  constructor(readonly database: AppDatabase) {}

  close(): void {
    this.database.raw.close();
  }

  appendEvent(event: EventRecord): EventRecord & { id: number } {
    const result = this.database.raw
      .prepare(`INSERT INTO events
      (event_id, schema_version, type, source, session_id, thread_id, run_id, task_id, correlation_id, created_at, payload)
      VALUES (@eventId, @schemaVersion, @type, @source, @sessionId, @threadId, @runId, @taskId, @correlationId, @createdAt, @payload)`)
      .run({
        eventId: event.eventId,
        schemaVersion: event.schemaVersion,
        type: event.type,
        source: event.source,
        sessionId: event.sessionId ?? null,
        threadId: event.threadId ?? null,
        runId: event.runId ?? null,
        taskId: event.taskId ?? null,
        correlationId: event.correlationId,
        createdAt: event.createdAt,
        payload: JSON.stringify(redactValue(event.payload)),
      });
    return { ...event, id: Number(result.lastInsertRowid) };
  }

  listEvents(afterId = 0, limit = 200): Array<EventRecord & { id: number }> {
    const rows = this.database.raw
      .prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?')
      .all(afterId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      eventId: String(row.event_id),
      schemaVersion: Number(row.schema_version) as 1,
      type: String(row.type) as EventRecord['type'],
      source: String(row.source),
      ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
      ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
      ...(row.run_id ? { runId: String(row.run_id) } : {}),
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      correlationId: String(row.correlation_id),
      createdAt: Number(row.created_at),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    }));
  }

  createSession(
    title = 'New session',
    now = Date.now(),
  ): { session: SessionRow; thread: ThreadRow } {
    const session: SessionRow = {
      id: randomUUID(),
      title,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const thread: ThreadRow = {
      id: randomUUID(),
      sessionId: session.id,
      title: 'Main thread',
      createdAt: now,
      updatedAt: now,
    };
    const transaction = this.database.raw.transaction(() => {
      this.database.raw
        .prepare(
          'INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(session.id, session.title, session.status, now, now);
      this.database.raw
        .prepare(
          'INSERT INTO threads (id, session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(thread.id, thread.sessionId, thread.title, now, now);
    });
    transaction();
    return { session, thread };
  }

  listSessions(): SessionRow[] {
    return this.database.raw
      .prepare(
        'SELECT id, title, status, created_at AS createdAt, updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC',
      )
      .all() as SessionRow[];
  }

  createThread(sessionId: string, title = 'New thread', now = Date.now()): ThreadRow {
    if (!this.getSession(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    const thread: ThreadRow = {
      id: randomUUID(),
      sessionId,
      title,
      createdAt: now,
      updatedAt: now,
    };
    this.database.raw
      .prepare(
        'INSERT INTO threads (id, session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(thread.id, thread.sessionId, thread.title, now, now);
    return thread;
  }

  getSession(id: string): SessionRow | undefined {
    return this.database.raw
      .prepare(
        'SELECT id, title, status, created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE id = ?',
      )
      .get(id) as SessionRow | undefined;
  }

  getThread(id: string): ThreadRow | undefined {
    return this.database.raw
      .prepare(
        'SELECT id, session_id AS sessionId, title, created_at AS createdAt, updated_at AS updatedAt FROM threads WHERE id = ?',
      )
      .get(id) as ThreadRow | undefined;
  }

  listThreads(sessionId: string): ThreadRow[] {
    return this.database.raw
      .prepare(
        'SELECT id, session_id AS sessionId, title, created_at AS createdAt, updated_at AS updatedAt FROM threads WHERE session_id = ? ORDER BY updated_at DESC',
      )
      .all(sessionId) as ThreadRow[];
  }

  addMessage(
    threadId: string,
    role: string,
    content: string,
    provider?: string,
    model?: string,
    now = Date.now(),
  ): MessageRow {
    const message: MessageRow = {
      id: randomUUID(),
      threadId,
      role,
      content,
      provider: provider ?? null,
      model: model ?? null,
      createdAt: now,
    };
    this.database.raw
      .prepare(
        'INSERT INTO messages (id, thread_id, role, content, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(message.id, threadId, role, content, provider ?? null, model ?? null, now);
    this.database.raw.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now, threadId);
    return message;
  }

  listMessages(threadId: string, limit = 100): MessageRow[] {
    return this.database.raw
      .prepare(
        'SELECT id, thread_id AS threadId, role, content, provider, model, created_at AS createdAt FROM messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?',
      )
      .all(threadId, limit) as MessageRow[];
  }

  createRun(
    threadId: string,
    input: string,
    provider: string,
    model: string,
    correlationId: string,
    now = Date.now(),
  ): RunRow {
    const run: RunRow = {
      id: randomUUID(),
      threadId,
      status: 'queued',
      provider,
      model,
      input,
      output: '',
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
      correlationId,
    };
    this.database.raw
      .prepare(
        'INSERT INTO runs (id, thread_id, status, provider, model, input, output, cancel_requested, created_at, updated_at, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(run.id, threadId, run.status, provider, model, input, '', 0, now, now, correlationId);
    return run;
  }

  getRun(id: string): RunRow | undefined {
    const row = this.database.raw
      .prepare(
        'SELECT id, thread_id AS threadId, status, provider, model, input, output, cancel_requested AS cancelRequested, created_at AS createdAt, updated_at AS updatedAt, correlation_id AS correlationId FROM runs WHERE id = ?',
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      threadId: String(row.threadId),
      status: String(row.status),
      provider: String(row.provider),
      model: String(row.model),
      input: String(row.input),
      output: String(row.output),
      cancelRequested: Boolean(row.cancelRequested),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      correlationId: String(row.correlationId),
    };
  }

  listActiveRuns(): RunRow[] {
    const rows = this.database.raw
      .prepare("SELECT id FROM runs WHERE status IN ('queued', 'running') ORDER BY created_at")
      .all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.getRun(id)).filter((run): run is RunRow => Boolean(run));
  }

  updateRun(
    id: string,
    values: Partial<Pick<RunRow, 'status' | 'output' | 'cancelRequested'>>,
    now = Date.now(),
  ): void {
    const run = this.getRun(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    const next = { ...run, ...values, updatedAt: now };
    this.database.raw
      .prepare(
        'UPDATE runs SET status = ?, output = ?, cancel_requested = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.status, next.output, next.cancelRequested ? 1 : 0, now, id);
  }

  requestRunCancel(id: string): void {
    this.database.raw
      .prepare('UPDATE runs SET cancel_requested = 1, updated_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  storeMemory(
    id: string,
    content: string,
    embedding: number[] | null,
    metadata: Record<string, unknown> = {},
    now = Date.now(),
  ): void {
    const buffer = embedding ? Buffer.from(new Float32Array(embedding).buffer) : null;
    this.database.raw
      .prepare(
        'INSERT OR REPLACE INTO memory_records (id, content, metadata, embedding, embedding_dimensions, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        content,
        JSON.stringify(redactValue(metadata)),
        buffer,
        embedding?.length ?? null,
        now,
      );
    if (embedding?.length === 768) {
      const existing = this.database.raw
        .prepare('SELECT vector_rowid FROM memory_vector_refs WHERE memory_id = ?')
        .get(id) as { vector_rowid: number } | undefined;
      if (existing)
        this.database.raw
          .prepare('DELETE FROM memory_vectors WHERE rowid = ?')
          .run(existing.vector_rowid);
      const vector = this.database.raw
        .prepare('INSERT INTO memory_vectors (embedding) VALUES (?)')
        .run(new Float32Array(embedding));
      this.database.raw
        .prepare(
          'INSERT OR REPLACE INTO memory_vector_refs (memory_id, vector_rowid) VALUES (?, ?)',
        )
        .run(id, Number(vector.lastInsertRowid));
    }
  }

  searchMemory(
    embedding: number[],
    limit = 8,
  ): Array<{
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    distance: number;
    createdAt: number;
  }> {
    if (embedding.length !== 768) return [];
    const vectorRows = this.database.raw
      .prepare('SELECT rowid, distance FROM memory_vectors WHERE embedding MATCH ? AND k = ?')
      .all(new Float32Array(embedding), limit) as Array<{ rowid: number; distance: number }>;
    const references = new Map(
      (
        this.database.raw
          .prepare('SELECT memory_id, vector_rowid FROM memory_vector_refs')
          .all() as Array<{ memory_id: string; vector_rowid: number }>
      ).map((reference) => [reference.vector_rowid, reference.memory_id]),
    );
    const memories = new Map(this.searchMemoryRows().map((memory) => [memory.id, memory]));
    return vectorRows
      .map((row) => {
        const memoryId = references.get(row.rowid);
        const memory = memoryId ? memories.get(memoryId) : undefined;
        return memory
          ? {
              id: memory.id,
              content: memory.content,
              metadata: memory.metadata,
              distance: row.distance,
              createdAt: memory.createdAt,
            }
          : undefined;
      })
      .filter((memory): memory is NonNullable<typeof memory> => Boolean(memory));
  }

  searchMemoryRows(): Array<{
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    embedding: number[] | null;
    createdAt: number;
  }> {
    const rows = this.database.raw
      .prepare(
        'SELECT id, content, metadata, embedding, created_at AS createdAt FROM memory_records ORDER BY created_at DESC',
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      content: String(row.content),
      metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
      embedding: row.embedding
        ? Array.from(
            new Float32Array(
              (row.embedding as Buffer).buffer,
              (row.embedding as Buffer).byteOffset,
              (row.embedding as Buffer).byteLength / Float32Array.BYTES_PER_ELEMENT,
            ),
          )
        : null,
      createdAt: Number(row.createdAt),
    }));
  }

  putSecret(name: string, ciphertext: string, now = Date.now()): void {
    this.database.raw
      .prepare(
        'INSERT OR REPLACE INTO secrets (name, ciphertext, created_at, updated_at) VALUES (?, ?, COALESCE((SELECT created_at FROM secrets WHERE name = ?), ?), ?)',
      )
      .run(name, ciphertext, name, now, now);
  }
  hasSecret(name: string): boolean {
    return Boolean(this.database.raw.prepare('SELECT 1 FROM secrets WHERE name = ?').get(name));
  }
  getSecretCiphertext(name: string): string | undefined {
    return (
      this.database.raw.prepare('SELECT ciphertext FROM secrets WHERE name = ?').get(name) as
        | { ciphertext: string }
        | undefined
    )?.ciphertext;
  }
  deleteSecret(name: string): void {
    this.database.raw.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }

  listSchedules(): Array<Record<string, unknown>> {
    return this.database.raw
      .prepare(
        'SELECT id, name, type, expression, agent_input AS agentInput, enabled, next_run_at AS nextRunAt, last_run_at AS lastRunAt, policy, created_at AS createdAt, updated_at AS updatedAt FROM schedules ORDER BY created_at ASC',
      )
      .all() as Array<Record<string, unknown>>;
  }
  saveSchedule(
    schedule: {
      id: string;
      name: string;
      type: string;
      expression: string;
      agentInput: string;
      enabled: boolean;
      nextRunAt: number | null;
      lastRunAt?: number | null;
      policy?: unknown;
    },
    now = Date.now(),
  ): void {
    this.database.raw
      .prepare(
        'INSERT OR REPLACE INTO schedules (id, name, type, expression, agent_input, enabled, next_run_at, last_run_at, policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM schedules WHERE id = ?), ?), ?)',
      )
      .run(
        schedule.id,
        schedule.name,
        schedule.type,
        schedule.expression,
        schedule.agentInput,
        schedule.enabled ? 1 : 0,
        schedule.nextRunAt,
        schedule.lastRunAt ?? null,
        JSON.stringify(schedule.policy ?? {}),
        schedule.id,
        now,
        now,
      );
  }
  updateSchedule(
    id: string,
    values: { enabled?: boolean; nextRunAt?: number | null; lastRunAt?: number | null },
  ): void {
    const current = this.database.raw.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!current) throw new Error(`Unknown schedule: ${id}`);
    this.database.raw
      .prepare(
        'UPDATE schedules SET enabled = ?, next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        values.enabled === undefined ? current.enabled : values.enabled ? 1 : 0,
        values.nextRunAt === undefined ? current.next_run_at : values.nextRunAt,
        values.lastRunAt === undefined ? current.last_run_at : values.lastRunAt,
        Date.now(),
        id,
      );
  }
  upsertPlugin(plugin: Omit<PluginRow, 'updatedAt'>, now = Date.now()): void {
    this.database.raw
      .prepare(
        `INSERT INTO plugins
          (name, version, api_version, entry, enabled, capabilities, dependencies, config, source, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
          version = excluded.version,
          api_version = excluded.api_version,
          entry = excluded.entry,
          enabled = excluded.enabled,
          capabilities = excluded.capabilities,
          dependencies = excluded.dependencies,
          config = excluded.config,
          source = excluded.source,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at`,
      )
      .run(
        plugin.name,
        plugin.version,
        plugin.apiVersion,
        plugin.entry,
        plugin.enabled ? 1 : 0,
        JSON.stringify(plugin.capabilities),
        JSON.stringify(plugin.dependencies),
        JSON.stringify(plugin.config),
        plugin.source,
        plugin.lastError,
        now,
      );
  }
  listPlugins(): PluginRow[] {
    const rows = this.database.raw
      .prepare('SELECT * FROM plugins ORDER BY name ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      name: String(row.name),
      version: String(row.version),
      apiVersion: String(row.api_version),
      entry: String(row.entry),
      enabled: Boolean(row.enabled),
      capabilities: JSON.parse(String(row.capabilities)) as string[],
      dependencies: JSON.parse(String(row.dependencies)) as Record<string, string>,
      config: JSON.parse(String(row.config)) as Record<string, unknown>,
      source: String(row.source),
      lastError: row.last_error === null ? null : String(row.last_error),
      updatedAt: Number(row.updated_at),
    }));
  }
  updatePlugin(
    name: string,
    values: { enabled?: boolean; config?: Record<string, unknown>; lastError?: string | null },
    now = Date.now(),
  ): void {
    const current = this.listPlugins().find((plugin) => plugin.name === name);
    if (!current) throw new Error(`Unknown plugin: ${name}`);
    this.upsertPlugin(
      {
        ...current,
        enabled: values.enabled ?? current.enabled,
        config: values.config ?? current.config,
        lastError: values.lastError === undefined ? current.lastError : values.lastError,
      },
      now,
    );
  }
  deletePlugin(name: string): void {
    this.database.raw.prepare('DELETE FROM plugins WHERE name = ?').run(name);
  }
  createTask(
    kind: string,
    payload: Record<string, unknown>,
    scheduleId: string | null = null,
    now = Date.now(),
  ): TaskRow {
    const task: TaskRow = {
      id: randomUUID(),
      kind,
      status: 'queued',
      payload,
      scheduleId,
      createdAt: now,
      updatedAt: now,
    };
    this.database.raw
      .prepare(
        'INSERT INTO tasks (id, kind, status, payload, schedule_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        task.id,
        task.kind,
        task.status,
        JSON.stringify(task.payload),
        task.scheduleId,
        now,
        now,
      );
    return task;
  }
  updateTask(id: string, status: string, payload?: Record<string, unknown>): void {
    const current = this.database.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!current) throw new Error(`Unknown task: ${id}`);
    this.database.raw
      .prepare('UPDATE tasks SET status = ?, payload = ?, updated_at = ? WHERE id = ?')
      .run(status, JSON.stringify(payload ?? JSON.parse(String(current.payload))), Date.now(), id);
  }
  listTasks(): TaskRow[] {
    const rows = this.database.raw
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      status: String(row.status),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      scheduleId: row.schedule_id ? String(row.schedule_id) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }
}
