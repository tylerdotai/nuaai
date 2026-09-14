import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';

import { workspaceDirectory } from '../config/index.js';
import { type ContextMessage, estimateMessageTokens, estimateTokens } from '../core/context.js';
import type { EventRecord } from '../core/events.js';
import type { ProviderToolCall } from '../providers/types.js';
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
  sourceKey: string | null;
  context: string;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadRow {
  id: string;
  sessionId: string;
  title: string;
  sourceKey: string | null;
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

export interface MessagePage {
  messages: MessageRow[];
  nextCursor: number;
  hasMore: boolean;
}

export interface ThreadSummaryRow {
  threadId: string;
  summary: string;
  throughMessageId: string;
  messageCount: number;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
  sourceMessageCount: number;
  sourceSha256: string;
  sourceProvenance: 'sha256:canonical-message-v1';
  estimatedOriginalTokens: number;
  estimatedSummaryTokens: number;
  version: number;
  updatedAt: number;
}

export type StructuredMessageRow = Omit<MessageRow, 'role'> & ContextMessage;

export interface MessageArtifactRow {
  messageId: string;
  kind: string;
  payload: Record<string, unknown>;
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

export interface RunArtifactRow {
  id: string;
  runId: string;
  threadId: string;
  kind: string;
  title: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  sourceTool: string;
  metadata: Record<string, unknown>;
  externalUrl: string | null;
  storagePath: string | null;
  createdAt: number;
}

export interface EventPage {
  events: Array<EventRecord & { id: number }>;
  nextCursor: number;
  hasMore: boolean;
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
      source_key TEXT UNIQUE,
      context TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_key TEXT UNIQUE,
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
    CREATE TABLE IF NOT EXISTS message_artifacts (
      message_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, kind)
    );
    CREATE TABLE IF NOT EXISTS thread_summaries (
      thread_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      through_message_id TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      source_start_message_id TEXT NOT NULL DEFAULT '',
      source_sha256 TEXT NOT NULL DEFAULT '',
      source_provenance TEXT NOT NULL DEFAULT 'sha256:canonical-message-v1',
      estimated_original_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_summary_tokens INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
    CREATE TABLE IF NOT EXISTS run_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('file', 'diff', 'test-report', 'screenshot', 'citation', 'deployment-receipt')),
      title TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      sha256 TEXT NOT NULL,
      source_tool TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      external_url TEXT,
      storage_path TEXT,
      created_at INTEGER NOT NULL,
      CHECK (external_url IS NOT NULL OR storage_path IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS run_writers (
      thread_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      lease_until INTEGER NOT NULL
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
    CREATE INDEX IF NOT EXISTS events_session_id_idx ON events(session_id, id);
    CREATE INDEX IF NOT EXISTS events_thread_id_idx ON events(thread_id, id);
    CREATE INDEX IF NOT EXISTS events_run_id_idx ON events(run_id, id);
    CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS runs_thread_idx ON runs(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS run_artifacts_run_idx ON run_artifacts(run_id, created_at, id);
    CREATE INDEX IF NOT EXISTS run_artifacts_thread_idx ON run_artifacts(thread_id, created_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS runs_correlation_id_idx ON runs(correlation_id);
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
  const summaryColumns = db.prepare('PRAGMA table_info(thread_summaries)').all() as Array<{
    name: string;
  }>;
  const summaryMigrations: Array<[string, string]> = [
    [
      'source_start_message_id',
      "ALTER TABLE thread_summaries ADD COLUMN source_start_message_id TEXT NOT NULL DEFAULT ''",
    ],
    [
      'source_sha256',
      "ALTER TABLE thread_summaries ADD COLUMN source_sha256 TEXT NOT NULL DEFAULT ''",
    ],
    [
      'source_provenance',
      "ALTER TABLE thread_summaries ADD COLUMN source_provenance TEXT NOT NULL DEFAULT 'sha256:canonical-message-v1'",
    ],
    [
      'estimated_original_tokens',
      'ALTER TABLE thread_summaries ADD COLUMN estimated_original_tokens INTEGER NOT NULL DEFAULT 0',
    ],
    [
      'estimated_summary_tokens',
      'ALTER TABLE thread_summaries ADD COLUMN estimated_summary_tokens INTEGER NOT NULL DEFAULT 0',
    ],
  ];
  for (const [name, migration] of summaryMigrations)
    if (!summaryColumns.some((column) => column.name === name)) db.exec(migration);
  db.prepare("UPDATE schema_meta SET value = '5' WHERE key = 'schema_version'").run();
  if (vector) {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(embedding float[768]);');
  }
}

function archiveDuplicateSourceBindings(db: MemoryDatabase, table: 'sessions' | 'threads'): void {
  const rows = db
    .prepare(
      `SELECT rowid AS rowId, id, source_key AS sourceKey
       FROM ${table}
       WHERE source_key IS NOT NULL
       ORDER BY source_key, updated_at DESC, rowid DESC`,
    )
    .all() as Array<{ rowId: number; id: string; sourceKey: string }>;
  const seen = new Set<string>();
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE source_key = ? AND id <> ?`);
  const update = db.prepare(`UPDATE ${table} SET source_key = ? WHERE id = ?`);
  const migrate = db.transaction(() => {
    for (const row of rows) {
      if (!seen.has(row.sourceKey)) {
        seen.add(row.sourceKey);
        continue;
      }
      let archived = `${row.sourceKey}:history:${row.id}:legacy:${row.rowId}`;
      let suffix = 1;
      while (exists.get(archived, row.id)) archived = `${archived}:${suffix++}`;
      update.run(archived, row.id);
      seen.add(archived);
    }
  });
  migrate();
}

function openRaw(root: string, loadVector = false): MemoryDatabase {
  const directory = workspaceDirectory(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, 'memory.db');
  const db = new Database(path);
  chmodSync(path, 0o600);
  db.pragma('journal_mode = WAL');
  if (loadVector) loadSqliteVec(db);
  createSchema(db, loadVector);
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === 'source_key'))
    db.exec('ALTER TABLE sessions ADD COLUMN source_key TEXT');
  if (!sessionColumns.some((column) => column.name === 'context'))
    db.exec("ALTER TABLE sessions ADD COLUMN context TEXT NOT NULL DEFAULT ''");
  const threadColumns = db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>;
  if (!threadColumns.some((column) => column.name === 'source_key'))
    db.exec('ALTER TABLE threads ADD COLUMN source_key TEXT');
  archiveDuplicateSourceBindings(db, 'sessions');
  archiveDuplicateSourceBindings(db, 'threads');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS sessions_source_key_idx ON sessions(source_key) WHERE source_key IS NOT NULL',
  );
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS threads_source_key_idx ON threads(source_key) WHERE source_key IS NOT NULL',
  );
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

function providerToolCalls(value: unknown): ProviderToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.filter(
    (call): call is ProviderToolCall =>
      Boolean(call) &&
      typeof call === 'object' &&
      typeof (call as ProviderToolCall).id === 'string' &&
      typeof (call as ProviderToolCall).name === 'string' &&
      Boolean((call as ProviderToolCall).arguments) &&
      typeof (call as ProviderToolCall).arguments === 'object' &&
      !Array.isArray((call as ProviderToolCall).arguments),
  );
  return calls.length === value.length && calls.length ? calls : undefined;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function summarySourceHash(messages: StructuredMessageRow[]): string {
  const canonical = messages.map((message) =>
    stableValue({
      id: message.id,
      role: message.role,
      content: message.content,
      provider: message.provider,
      model: message.model,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      pinned: message.pinned === true,
    }),
  );
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function extractiveSummary(
  messages: StructuredMessageRow[],
  maxTokens: number,
  previousSummary = '',
): string {
  const boundedMax = Math.max(0, Math.trunc(maxTokens));
  const records = messages.map((message, index) => ({
    index,
    important:
      message.pinned === true ||
      previousSummary.includes(`[${message.id}] ${message.role}: ${message.content}`) ||
      /\b(?:always|never|must|remember|constraint|require|required|prefer|fact|do not|don't)\b/iu.test(
        message.content,
      ),
    text: `[${message.id}] ${message.role}: ${message.content}`,
  }));
  const selected = new Set<number>();
  let used = 0;
  const trySelect = (record: (typeof records)[number]): void => {
    if (selected.has(record.index)) return;
    const separator = selected.size ? 1 : 0;
    const tokens = separator + estimateTokens(record.text);
    if (used + tokens > boundedMax) return;
    selected.add(record.index);
    used += tokens;
  };
  for (const record of records) if (record.important) trySelect(record);
  for (let index = records.length - 1; index >= 0; index -= 1) trySelect(records[index]);

  const omitted = records.length - selected.size;
  if (omitted) {
    const marker = `[${omitted} complete source record${omitted === 1 ? '' : 's'} omitted by summary token budget]`;
    const separator = selected.size ? 1 : 0;
    const markerTokens = separator + estimateTokens(marker);
    if (used + markerTokens <= boundedMax) {
      selected.add(records.length);
      records.push({ index: records.length, important: false, text: marker });
    }
  }
  const summary = records
    .filter((record) => selected.has(record.index))
    .sort((left, right) => left.index - right.index)
    .map((record) => record.text)
    .join('\n');
  if (estimateTokens(summary) <= boundedMax) return summary;
  throw new Error('Extractive summary exceeded its token budget');
}

export class DatabaseStore {
  constructor(readonly database: AppDatabase) {}

  transaction<T>(action: () => T): T {
    return this.database.raw.transaction(action)();
  }

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
    return rows.map((row) => this.eventFromRow(row));
  }

  listEventsForSession(sessionId: string, afterId = 0, limit = 200): EventPage {
    return this.listScopedEvents('session_id', sessionId, afterId, limit);
  }

  eventHighWaterForSession(sessionId: string): number {
    const row = this.database.raw
      .prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE session_id = ?')
      .get(sessionId) as { id: number };
    return row.id;
  }

  listEventsForThread(threadId: string, afterId = 0, limit = 200): EventPage {
    return this.listScopedEvents('thread_id', threadId, afterId, limit);
  }

  listRecentEventsForRun(runId: string, limit = 200): Array<EventRecord & { id: number }> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(1_000, Math.max(1, Math.trunc(limit)))
      : 200;
    const rows = this.database.raw
      .prepare(
        'SELECT * FROM (SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
      )
      .all(runId, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.eventFromRow(row));
  }

  listProjectionEventsForRun(
    runId: string,
    recentLimit = 250,
  ): Array<EventRecord & { id: number }> {
    const recent = this.listRecentEventsForRun(runId, recentLimit);
    const lifecycleRows = this.database.raw
      .prepare(
        "SELECT * FROM events WHERE run_id = ? AND type <> 'model.delta' ORDER BY id DESC LIMIT 1000",
      )
      .all(runId) as Array<Record<string, unknown>>;
    const byId = new Map<number, EventRecord & { id: number }>();
    for (const event of recent) byId.set(event.id, event);
    for (const row of lifecycleRows) {
      const event = this.eventFromRow(row);
      byId.set(event.id, event);
    }
    return [...byId.values()].sort((left, right) => left.id - right.id);
  }

  private listScopedEvents(
    column: 'session_id' | 'thread_id',
    value: string,
    afterId: number,
    limit: number,
  ): EventPage {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(1_000, Math.max(1, Math.trunc(limit)))
      : 200;
    const boundedAfter = Number.isFinite(afterId) ? Math.max(0, Math.trunc(afterId)) : 0;
    const rows = this.database.raw
      .prepare(`SELECT * FROM events WHERE ${column} = ? AND id > ? ORDER BY id ASC LIMIT ?`)
      .all(value, boundedAfter, boundedLimit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > boundedLimit;
    const events = rows.slice(0, boundedLimit).map((row) => this.eventFromRow(row));
    return {
      events,
      nextCursor: events.at(-1)?.id ?? boundedAfter,
      hasMore,
    };
  }

  private eventFromRow(row: Record<string, unknown>): EventRecord & { id: number } {
    return {
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
    };
  }

  createSession(
    title = 'New session',
    now = Date.now(),
    context = '',
    sourceKey: string | null = null,
    id: string = randomUUID(),
  ): { session: SessionRow; thread: ThreadRow } {
    const session: SessionRow = {
      id,
      title,
      status: 'active',
      sourceKey,
      context,
      createdAt: now,
      updatedAt: now,
    };
    const thread: ThreadRow = {
      id: randomUUID(),
      sessionId: session.id,
      title: 'Main thread',
      sourceKey: null,
      createdAt: now,
      updatedAt: now,
    };
    const transaction = this.database.raw.transaction(() => {
      this.database.raw
        .prepare(
          'INSERT INTO sessions (id, title, status, source_key, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(session.id, session.title, session.status, sourceKey, context, now, now);
      this.database.raw
        .prepare(
          'INSERT INTO threads (id, session_id, title, source_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(thread.id, thread.sessionId, thread.title, thread.sourceKey, now, now);
    });
    transaction();
    return { session, thread };
  }

  listSessions(includeOrphans = true): SessionRow[] {
    const query = includeOrphans
      ? 'SELECT id, title, status, source_key AS sourceKey, context, created_at AS createdAt, updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC, rowid DESC'
      : 'SELECT id, title, status, source_key AS sourceKey, context, created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE source_key IS NOT NULL ORDER BY updated_at DESC, rowid DESC';
    return this.database.raw.prepare(query).all() as SessionRow[];
  }

  getSessionBySource(sourceKey: string): SessionRow | undefined {
    return this.database.raw
      .prepare(
        'SELECT id, title, status, source_key AS sourceKey, context, created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE source_key = ?',
      )
      .get(sourceKey) as SessionRow | undefined;
  }

  createThread(
    sessionId: string,
    title = 'New thread',
    now = Date.now(),
    sourceKey: string | null = null,
  ): ThreadRow {
    if (!this.getSession(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    const thread: ThreadRow = {
      id: randomUUID(),
      sessionId,
      title,
      sourceKey,
      createdAt: now,
      updatedAt: now,
    };
    this.database.raw
      .prepare(
        'INSERT INTO threads (id, session_id, title, source_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(thread.id, thread.sessionId, thread.title, thread.sourceKey, now, now);
    return thread;
  }

  getSession(id: string): SessionRow | undefined {
    return this.database.raw
      .prepare(
        'SELECT id, title, status, source_key AS sourceKey, context, created_at AS createdAt, updated_at AS updatedAt FROM sessions WHERE id = ?',
      )
      .get(id) as SessionRow | undefined;
  }

  updateSessionContext(id: string, context: string, now = Date.now()): void {
    this.database.raw
      .prepare('UPDATE sessions SET context = ?, updated_at = ? WHERE id = ?')
      .run(context, now, id);
  }

  setSessionSourceKey(id: string, sourceKey: string | null, now = Date.now()): void {
    this.database.raw
      .prepare('UPDATE sessions SET source_key = ?, updated_at = ? WHERE id = ?')
      .run(sourceKey, now, id);
  }

  setThreadSourceKey(id: string, sourceKey: string | null, now = Date.now()): void {
    this.database.raw
      .prepare('UPDATE threads SET source_key = ?, updated_at = ? WHERE id = ?')
      .run(sourceKey, now, id);
  }

  getThreadBySource(sourceKey: string): ThreadRow | undefined {
    return this.database.raw
      .prepare(
        'SELECT id, session_id AS sessionId, title, source_key AS sourceKey, created_at AS createdAt, updated_at AS updatedAt FROM threads WHERE source_key = ?',
      )
      .get(sourceKey) as ThreadRow | undefined;
  }

  getThread(id: string): ThreadRow | undefined {
    return this.database.raw
      .prepare(
        'SELECT id, session_id AS sessionId, title, source_key AS sourceKey, created_at AS createdAt, updated_at AS updatedAt FROM threads WHERE id = ?',
      )
      .get(id) as ThreadRow | undefined;
  }

  listThreads(sessionId: string): ThreadRow[] {
    return this.database.raw
      .prepare(
        'SELECT id, session_id AS sessionId, title, source_key AS sourceKey, created_at AS createdAt, updated_at AS updatedAt FROM threads WHERE session_id = ? ORDER BY updated_at DESC',
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

  storeMessageArtifact(
    messageId: string,
    kind: string,
    payload: Record<string, unknown>,
    now = Date.now(),
  ): void {
    this.database.raw
      .prepare(
        'INSERT OR REPLACE INTO message_artifacts (message_id, kind, payload, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(messageId, kind, JSON.stringify(redactValue(payload)), now);
  }

  listMessageArtifacts(messageId: string): MessageArtifactRow[] {
    const rows = this.database.raw
      .prepare(
        'SELECT message_id AS messageId, kind, payload, created_at AS createdAt FROM message_artifacts WHERE message_id = ? ORDER BY created_at ASC',
      )
      .all(messageId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      messageId: String(row.messageId),
      kind: String(row.kind),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      createdAt: Number(row.createdAt),
    }));
  }

  listThreadArtifacts(threadId: string): MessageArtifactRow[] {
    const rows = this.database.raw
      .prepare(
        'SELECT a.message_id AS messageId, a.kind, a.payload, a.created_at AS createdAt FROM message_artifacts a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ? ORDER BY a.created_at ASC',
      )
      .all(threadId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      messageId: String(row.messageId),
      kind: String(row.kind),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      createdAt: Number(row.createdAt),
    }));
  }

  listMessages(threadId: string, limit = 100): MessageRow[] {
    const messages = this.database.raw
      .prepare(
        'SELECT id, thread_id AS threadId, role, content, provider, model, created_at AS createdAt FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?',
      )
      .all(threadId, limit) as MessageRow[];
    return messages.reverse();
  }

  listMessagePage(threadId: string, beforeRowId?: number, limit = 100): MessagePage {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(500, Math.max(1, Math.trunc(limit)))
      : 100;
    const before =
      beforeRowId !== undefined && Number.isFinite(beforeRowId)
        ? Math.max(1, Math.trunc(beforeRowId))
        : Number.MAX_SAFE_INTEGER;
    const rows = this.database.raw
      .prepare(
        'SELECT rowid AS rowId, id, thread_id AS threadId, role, content, provider, model, created_at AS createdAt FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?',
      )
      .all(threadId, before, boundedLimit + 1) as Array<MessageRow & { rowId: number }>;
    const hasMore = rows.length > boundedLimit;
    const selected = rows.slice(0, boundedLimit);
    const nextCursor = selected.at(-1)?.rowId ?? before;
    const messages = selected.reverse().map(({ rowId: _rowId, ...message }) => message);
    return { messages, nextCursor, hasMore };
  }

  getThreadSummary(threadId: string): ThreadSummaryRow | undefined {
    const row = this.database.raw
      .prepare(
        `SELECT thread_id AS threadId, summary,
          through_message_id AS throughMessageId,
          through_message_id AS sourceEndMessageId,
          message_count AS messageCount,
          message_count AS sourceMessageCount,
          source_start_message_id AS sourceStartMessageId,
          source_sha256 AS sourceSha256,
          source_provenance AS sourceProvenance,
          estimated_original_tokens AS estimatedOriginalTokens,
          estimated_summary_tokens AS estimatedSummaryTokens,
          version, updated_at AS updatedAt
        FROM thread_summaries WHERE thread_id = ?`,
      )
      .get(threadId) as ThreadSummaryRow | undefined;
    return row;
  }

  listStructuredMessagesThrough(
    threadId: string,
    throughMessageId: string,
  ): StructuredMessageRow[] {
    const messages = this.listMessages(threadId, 100_000);
    const throughIndex = messages.findIndex((message) => message.id === throughMessageId);
    if (throughIndex < 0) throw new Error(`Unknown message: ${throughMessageId}`);
    const summary = this.getThreadSummary(threadId);
    const summaryIndex = summary
      ? messages.findIndex((message) => message.id === summary.sourceEndMessageId)
      : -1;
    const source = messages.slice(Math.max(0, summaryIndex + 1), throughIndex + 1);
    const artifacts = new Map<string, MessageArtifactRow[]>();
    for (const artifact of this.listThreadArtifacts(threadId)) {
      const existing = artifacts.get(artifact.messageId) ?? [];
      existing.push(artifact);
      artifacts.set(artifact.messageId, existing);
    }
    return source.map((message) => {
      const messageArtifacts = artifacts.get(message.id) ?? [];
      const callsArtifact = messageArtifacts.find((artifact) => artifact.kind === 'tool_calls');
      const resultArtifact = messageArtifacts.find((artifact) => artifact.kind === 'tool_result');
      const pinArtifact = messageArtifacts.find((artifact) => artifact.kind === 'context_pin');
      const toolCalls = providerToolCalls(callsArtifact?.payload.calls);
      const toolCallId =
        typeof resultArtifact?.payload.callId === 'string'
          ? resultArtifact.payload.callId
          : undefined;
      const toolName =
        typeof resultArtifact?.payload.name === 'string' ? resultArtifact.payload.name : undefined;
      return {
        ...message,
        role: message.role as ContextMessage['role'],
        ...(toolCalls ? { toolCalls } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        ...(toolName ? { toolName } : {}),
        ...(pinArtifact && pinArtifact.payload.pinned !== false ? { pinned: true } : {}),
      };
    });
  }

  compactThreadThrough(
    threadId: string,
    throughMessageId: string,
    maxSummaryTokens = 4_096,
    now = Date.now(),
  ): ThreadSummaryRow {
    const allMessages = this.listMessages(threadId, 100_000);
    const throughIndex = allMessages.findIndex((message) => message.id === throughMessageId);
    if (throughIndex < 0) throw new Error(`Unknown message: ${throughMessageId}`);
    const previous = this.getThreadSummary(threadId);
    const previousIndex = previous
      ? allMessages.findIndex((message) => message.id === previous.sourceEndMessageId)
      : -1;
    if (previous && previousIndex > throughIndex) return previous;

    const sourceMessages = allMessages.slice(0, throughIndex + 1);
    const artifacts = new Map<string, MessageArtifactRow[]>();
    for (const artifact of this.listThreadArtifacts(threadId)) {
      const existing = artifacts.get(artifact.messageId) ?? [];
      existing.push(artifact);
      artifacts.set(artifact.messageId, existing);
    }
    const structured = sourceMessages.map((message) => {
      const messageArtifacts = artifacts.get(message.id) ?? [];
      const calls = providerToolCalls(
        messageArtifacts.find((artifact) => artifact.kind === 'tool_calls')?.payload.calls,
      );
      const result = messageArtifacts.find((artifact) => artifact.kind === 'tool_result');
      return {
        ...message,
        role: message.role as ContextMessage['role'],
        ...(calls ? { toolCalls: calls } : {}),
        ...(typeof result?.payload.callId === 'string'
          ? { toolCallId: result.payload.callId }
          : {}),
        ...(typeof result?.payload.name === 'string' ? { toolName: result.payload.name } : {}),
        ...(messageArtifacts.some(
          (artifact) => artifact.kind === 'context_pin' && artifact.payload.pinned !== false,
        )
          ? { pinned: true }
          : {}),
      } satisfies StructuredMessageRow;
    });
    const sourceSha256 = summarySourceHash(structured);
    const boundedSummaryTokens = Math.max(0, Math.trunc(maxSummaryTokens));
    if (
      previous &&
      previous.sourceEndMessageId === throughMessageId &&
      previous.sourceSha256 === sourceSha256 &&
      previous.estimatedSummaryTokens <= boundedSummaryTokens
    )
      return previous;

    const summary = extractiveSummary(structured, boundedSummaryTokens, previous?.summary);
    const summaryRow: ThreadSummaryRow = {
      threadId,
      summary,
      throughMessageId,
      messageCount: structured.length,
      sourceStartMessageId: structured[0].id,
      sourceEndMessageId: throughMessageId,
      sourceMessageCount: structured.length,
      sourceSha256,
      sourceProvenance: 'sha256:canonical-message-v1',
      estimatedOriginalTokens: structured.reduce(
        (total, message) => total + estimateMessageTokens(message),
        0,
      ),
      estimatedSummaryTokens: estimateTokens(summary),
      version: (previous?.version ?? 0) + 1,
      updatedAt: now,
    };
    this.database.raw
      .prepare(
        `INSERT INTO thread_summaries
          (thread_id, summary, through_message_id, message_count, source_start_message_id,
            source_sha256, source_provenance, estimated_original_tokens,
            estimated_summary_tokens, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          summary = excluded.summary,
          through_message_id = excluded.through_message_id,
          message_count = excluded.message_count,
          source_start_message_id = excluded.source_start_message_id,
          source_sha256 = excluded.source_sha256,
          source_provenance = excluded.source_provenance,
          estimated_original_tokens = excluded.estimated_original_tokens,
          estimated_summary_tokens = excluded.estimated_summary_tokens,
          version = excluded.version,
          updated_at = excluded.updated_at`,
      )
      .run(
        summaryRow.threadId,
        summaryRow.summary,
        summaryRow.sourceEndMessageId,
        summaryRow.sourceMessageCount,
        summaryRow.sourceStartMessageId,
        summaryRow.sourceSha256,
        summaryRow.sourceProvenance,
        summaryRow.estimatedOriginalTokens,
        summaryRow.estimatedSummaryTokens,
        summaryRow.version,
        summaryRow.updatedAt,
      );
    return summaryRow;
  }

  compactThread(
    threadId: string,
    keepMessages = 80,
    maxSummaryTokens = 4_096,
  ): ThreadSummaryRow | undefined {
    const messages = this.listMessages(threadId, 100_000);
    if (messages.length <= keepMessages) return this.getThreadSummary(threadId);
    let split = messages.length - keepMessages;
    while (split > 0 && messages[split]?.role === 'tool') split -= 1;
    if (split <= 0) return this.getThreadSummary(threadId);
    return this.compactThreadThrough(threadId, messages[split - 1].id, maxSummaryTokens);
  }

  listContextMessages(
    threadId: string,
    limit = 100,
  ): Array<MessageRow | { role: 'system'; content: string }> {
    const summary = this.getThreadSummary(threadId);
    if (!summary) return this.listMessages(threadId, limit);
    const messages = this.listMessages(threadId, 100_000);
    const index = messages.findIndex((message) => message.id === summary.throughMessageId);
    const recent = (index >= 0 ? messages.slice(index + 1) : messages).slice(-limit);
    return [
      {
        role: 'system',
        content: `Compacted transcript summary v${summary.version} through ${summary.throughMessageId}:\n${summary.summary}`,
      },
      ...recent,
    ];
  }

  listContextMessagesThrough(
    threadId: string,
    throughMessageId: string,
    limit = 100,
  ): Array<MessageRow | { role: 'system'; content: string }> {
    const messages = this.listMessages(threadId, 100_000);
    const throughIndex = messages.findIndex((message) => message.id === throughMessageId);
    if (throughIndex < 0) throw new Error(`Unknown message: ${throughMessageId}`);
    const through = messages.slice(0, throughIndex + 1);
    const summary = this.getThreadSummary(threadId);
    if (!summary) return through.slice(-limit);
    const summaryIndex = messages.findIndex((message) => message.id === summary.throughMessageId);
    if (summaryIndex < 0 || summaryIndex > throughIndex) return through.slice(-limit);
    return [
      {
        role: 'system',
        content: `Compacted transcript summary v${summary.version} through ${summary.throughMessageId}:\n${summary.summary}`,
      },
      ...through.slice(summaryIndex + 1).slice(-limit),
    ];
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

  createRunArtifact(artifact: RunArtifactRow): RunArtifactRow {
    const run = this.getRun(artifact.runId);
    if (!run) throw new Error(`Unknown run: ${artifact.runId}`);
    if (run.threadId !== artifact.threadId)
      throw new Error(`Run ${artifact.runId} does not belong to thread ${artifact.threadId}`);
    this.database.raw
      .prepare(
        'INSERT INTO run_artifacts (id, run_id, thread_id, kind, title, mime_type, byte_size, sha256, source_tool, metadata, external_url, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        artifact.id,
        artifact.runId,
        artifact.threadId,
        artifact.kind,
        artifact.title,
        artifact.mimeType,
        artifact.byteSize,
        artifact.sha256,
        artifact.sourceTool,
        JSON.stringify(redactValue(artifact.metadata)),
        artifact.externalUrl,
        artifact.storagePath,
        artifact.createdAt,
      );
    return this.getRunArtifact(artifact.id) as RunArtifactRow;
  }

  getRunArtifact(id: string): RunArtifactRow | undefined {
    const row = this.database.raw
      .prepare(
        'SELECT id, run_id AS runId, thread_id AS threadId, kind, title, mime_type AS mimeType, byte_size AS byteSize, sha256, source_tool AS sourceTool, metadata, external_url AS externalUrl, storage_path AS storagePath, created_at AS createdAt FROM run_artifacts WHERE id = ?',
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.runArtifactFromRow(row) : undefined;
  }

  listRunArtifacts(runId: string): RunArtifactRow[] {
    return (
      this.database.raw
        .prepare(
          'SELECT id, run_id AS runId, thread_id AS threadId, kind, title, mime_type AS mimeType, byte_size AS byteSize, sha256, source_tool AS sourceTool, metadata, external_url AS externalUrl, storage_path AS storagePath, created_at AS createdAt FROM run_artifacts WHERE run_id = ? ORDER BY created_at ASC, rowid ASC',
        )
        .all(runId) as Array<Record<string, unknown>>
    ).map((row) => this.runArtifactFromRow(row));
  }

  listThreadRunArtifacts(threadId: string): RunArtifactRow[] {
    return (
      this.database.raw
        .prepare(
          'SELECT id, run_id AS runId, thread_id AS threadId, kind, title, mime_type AS mimeType, byte_size AS byteSize, sha256, source_tool AS sourceTool, metadata, external_url AS externalUrl, storage_path AS storagePath, created_at AS createdAt FROM run_artifacts WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC',
        )
        .all(threadId) as Array<Record<string, unknown>>
    ).map((row) => this.runArtifactFromRow(row));
  }

  deleteRunArtifact(id: string): boolean {
    return this.database.raw.prepare('DELETE FROM run_artifacts WHERE id = ?').run(id).changes > 0;
  }

  private runArtifactFromRow(row: Record<string, unknown>): RunArtifactRow {
    return {
      id: String(row.id),
      runId: String(row.runId),
      threadId: String(row.threadId),
      kind: String(row.kind),
      title: String(row.title),
      mimeType: String(row.mimeType),
      byteSize: Number(row.byteSize),
      sha256: String(row.sha256),
      sourceTool: String(row.sourceTool),
      metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
      externalUrl: row.externalUrl === null ? null : String(row.externalUrl),
      storagePath: row.storagePath === null ? null : String(row.storagePath),
      createdAt: Number(row.createdAt),
    };
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

  listRuns(threadId: string, limit = 10): RunRow[] {
    const boundedLimit = Math.min(20, Math.max(1, Math.trunc(limit)));
    const rows = this.database.raw
      .prepare(
        'SELECT id FROM runs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(threadId, boundedLimit) as Array<{ id: string }>;
    return rows.map(({ id }) => this.getRun(id)).filter((run): run is RunRow => Boolean(run));
  }

  getLatestRun(threadId: string): RunRow | undefined {
    const row = this.database.raw
      .prepare(
        'SELECT id FROM runs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(threadId) as { id: string } | undefined;
    return row ? this.getRun(row.id) : undefined;
  }

  getRunByCorrelationId(correlationId: string): RunRow | undefined {
    const row = this.database.raw
      .prepare('SELECT id FROM runs WHERE correlation_id = ?')
      .get(correlationId) as { id: string } | undefined;
    return row ? this.getRun(row.id) : undefined;
  }

  listActiveRuns(): RunRow[] {
    const rows = this.database.raw
      .prepare("SELECT id FROM runs WHERE status IN ('queued', 'running') ORDER BY created_at")
      .all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.getRun(id)).filter((run): run is RunRow => Boolean(run));
  }

  listActiveRunsForThread(threadId: string): RunRow[] {
    const rows = this.database.raw
      .prepare(
        "SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued', 'running') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at ASC, rowid ASC",
      )
      .all(threadId) as Array<{ id: string }>;
    return rows.map(({ id }) => this.getRun(id)).filter((run): run is RunRow => Boolean(run));
  }

  claimRunWriter(
    threadId: string,
    runId: string,
    ownerId: string,
    leaseMs = 120_000,
    now = Date.now(),
  ): boolean {
    const claim = this.database.raw.transaction(() => {
      const current = this.database.raw
        .prepare(
          'SELECT run_id AS runId, owner_id AS ownerId, lease_until AS leaseUntil FROM run_writers WHERE thread_id = ?',
        )
        .get(threadId) as { runId: string; ownerId: string; leaseUntil: number } | undefined;
      if (
        current &&
        current.leaseUntil > now &&
        current.runId !== runId &&
        current.ownerId !== ownerId
      )
        return false;
      this.database.raw
        .prepare(
          'INSERT INTO run_writers (thread_id, run_id, owner_id, claimed_at, lease_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET run_id = excluded.run_id, owner_id = excluded.owner_id, claimed_at = excluded.claimed_at, lease_until = excluded.lease_until',
        )
        .run(threadId, runId, ownerId, now, now + leaseMs);
      return true;
    });
    return claim();
  }

  releaseRunWriter(threadId: string, runId: string, ownerId: string): void {
    this.database.raw
      .prepare('DELETE FROM run_writers WHERE thread_id = ? AND run_id = ? AND owner_id = ?')
      .run(threadId, runId, ownerId);
  }

  releaseAllRunWriters(): void {
    this.database.raw.prepare('DELETE FROM run_writers').run();
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

  searchMemoryLexical(
    query: string,
    limit = 8,
  ): Array<{
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    score: number;
    createdAt: number;
  }> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.searchMemoryRows()
      .map((memory) => {
        const haystack = memory.content.toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return {
          id: memory.id,
          content: memory.content,
          metadata: memory.metadata,
          score,
          createdAt: memory.createdAt,
        };
      })
      .filter((memory) => memory.score > 0)
      .sort((left, right) => right.score - left.score || right.createdAt - left.createdAt)
      .slice(0, limit);
  }

  deleteMemory(id: string): boolean {
    const reference = this.database.raw
      .prepare('SELECT vector_rowid FROM memory_vector_refs WHERE memory_id = ?')
      .get(id) as { vector_rowid: number } | undefined;
    const transaction = this.database.raw.transaction(() => {
      if (reference) {
        this.database.raw
          .prepare('DELETE FROM memory_vectors WHERE rowid = ?')
          .run(reference.vector_rowid);
        this.database.raw.prepare('DELETE FROM memory_vector_refs WHERE memory_id = ?').run(id);
      }
      const result = this.database.raw.prepare('DELETE FROM memory_records WHERE id = ?').run(id);
      return result.changes > 0;
    });
    return Boolean(transaction());
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
