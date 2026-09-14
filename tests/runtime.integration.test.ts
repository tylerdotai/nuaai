import { chmod, mkdir, readFile, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  defaultRuntimeConfig,
  loadRuntimeConfig,
  parseRuntimeConfig,
  persistProviderSelection,
  workspaceDirectory,
} from '../src/config/index.js';
import { createEvent } from '../src/core/events.js';
import { loadSessionIdentity } from '../src/core/identity.js';
import { AgentRuntime, requestRequiresVerifiedTool } from '../src/core/runtime.js';
import { Scheduler, nextCronRun } from '../src/core/scheduler.js';
import { startDaemon } from '../src/daemon.js';
import { acquireDaemonLock, daemonLockExists } from '../src/gateway/lock.js';
import { createBrowserPairingToken, ensureRuntimeIdentity } from '../src/gateway/runtime.js';
import { createToken, validateToken } from '../src/gateway/token.js';
import { SearchStack } from '../src/integrations/search.js';
import {
  DatabaseStore,
  addMemory,
  listMemories,
  openAppDatabase,
  openMemoryDatabase,
} from '../src/memory/db.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import { CodexProvider } from '../src/providers/codex.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { DeterministicProvider } from '../src/providers/test.js';
import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderImage,
  ProviderRequest,
  ProviderStreamEvent,
} from '../src/providers/types.js';
import { decryptSecret, encryptSecret, rotateSecret } from '../src/security/encryption.js';
import { PublicOutboundUrlPolicy } from '../src/security/outbound-url.js';
import { type PermissionContext, assertPermission } from '../src/security/permissions.js';
import { redactText, redactValue } from '../src/security/redaction.js';
import { SecretsManager } from '../src/security/secrets.js';
import { loadFilesystemSkills } from '../src/skills/loader.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';
import {
  assertSafeExistingPath,
  initWorkspace,
  listWorkspaceFiles,
  readWorkspaceFile,
  runWorkspaceCommand,
  searchWorkspace,
  textDiff,
} from '../src/workspace/fs.js';

const openStores: DatabaseStore[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  vi.restoreAllMocks();
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-integration-'));
  roots.push(root);
  await initWorkspace(root);
  return root;
}

function makeStore(root: string): DatabaseStore {
  const store = new DatabaseStore(openAppDatabase(root));
  openStores.push(store);
  return store;
}

const permissive: PermissionContext = {
  approved: new Set(['read', 'write', 'execute', 'secret']),
  capabilities: { filesystem: true, subprocess: true, secrets: true },
};

function providerMap(providers: Record<string, ProviderAdapter>) {
  return {
    get(name: string): ProviderAdapter {
      const provider = providers[name];
      if (!provider) throw new Error(`Unknown provider: ${name}`);
      return provider;
    },
    list: () => Object.keys(providers),
    health: async () => Promise.all(Object.values(providers).map((provider) => provider.health())),
  } as unknown as ProviderRegistry;
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function responseStream(lines: string[]): Response {
  return new Response(`${lines.join('\n')}\n`, {
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

describe('runtime configuration and security primitives', () => {
  it('normalizes runtime configuration and preserves the workspace identity', async () => {
    const root = await makeRoot();
    const defaults = defaultRuntimeConfig(root);
    expect(defaults).toMatchObject({ name: 'NUAAI', version: 1, workspaceRoot: resolve(root) });
    expect(defaults.permissions).toEqual({
      web: 'operator',
      matrix: 'operator',
      scheduler: 'operator',
    });
    expect(defaults.limits.runTimeoutMs).toBeGreaterThan(defaults.provider.codex.timeoutMs);
    expect(defaults.limits.maxToolCalls).toBe(48);
    expect(defaults.limits.maxTurns).toBeGreaterThanOrEqual(defaults.limits.maxToolCalls);
    const codexConfig = parseRuntimeConfig({ provider: { name: 'codex' } }, root);
    expect(codexConfig).toMatchObject({
      name: 'NUAAI',
      provider: {
        name: 'codex',
        model: '',
        codex: {
          executable: 'codex',
          timeoutMs: 900_000,
        },
      },
    });
    expect(codexConfig.provider.codex).not.toHaveProperty('sandboxMode');
    expect(codexConfig.provider.codex).not.toHaveProperty('approvalPolicy');
    expect(codexConfig.provider.codex).not.toHaveProperty('postToolQuietTimeoutMs');
    expect(
      parseRuntimeConfig({ provider: { name: 'codex', model: 'gpt-live' } }, root),
    ).toMatchObject({
      provider: { name: 'codex', model: 'gpt-live' },
    });
    const migratedCodexConfig = parseRuntimeConfig(
      {
        provider: {
          name: 'codex',
          codex: {
            sandboxMode: 'danger-full-access',
            approvalPolicy: 'never',
            postToolQuietTimeoutMs: 90_000,
          },
        },
      },
      root,
    );
    expect(migratedCodexConfig.provider.codex).toEqual({
      executable: 'codex',
      timeoutMs: 900_000,
    });
    expect(() =>
      parseRuntimeConfig(
        {
          matrix: {
            enabled: true,
            homeserverUrl: 'https://matrix.example.test',
            userId: '@nuaai:example.test',
            accessToken: 'test-token',
            allowedUsers: [],
            allowedRooms: [],
          },
        },
        root,
      ),
    ).toThrow('Matrix requires at least one allowed user or room');
    expect(workspaceDirectory(root)).toBe(join(root, '.nuaai'));
    await expect(loadRuntimeConfig(root)).resolves.toMatchObject({ name: 'NUAAI', version: 1 });
    const previousPort = process.env.NUAAI_PORT;
    process.env.NUAAI_PORT = '41234';
    expect(parseRuntimeConfig({}, root).port).toBe(41234);
    if (previousPort === undefined) process.env.NUAAI_PORT = undefined;
    else process.env.NUAAI_PORT = previousPort;
    const matrixEnvironment = {
      NUAAI_MATRIX_ALLOWED_USERS: '@operator:example.org,@ops:example.org',
      NUAAI_MATRIX_ALLOWED_ROOMS: '!room:example.org',
      NUAAI_MATRIX_REQUIRE_MENTION: 'true',
      NUAAI_MATRIX_MAX_MESSAGE_LENGTH: '12000',
    };
    const previousMatrixEnvironment = Object.fromEntries(
      Object.keys(matrixEnvironment).map((name) => [name, process.env[name]]),
    );
    try {
      Object.assign(process.env, matrixEnvironment);
      expect(parseRuntimeConfig({}, root).matrix).toMatchObject({
        allowedUsers: ['@operator:example.org', '@ops:example.org'],
        allowedRooms: ['!room:example.org'],
        requireMention: true,
        maxMessageLength: 12_000,
      });
    } finally {
      for (const [name, value] of Object.entries(previousMatrixEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    await expect(persistProviderSelection(root, 'ollama', 'vision-model')).resolves.toBeUndefined();
    await expect(loadRuntimeConfig(root)).resolves.toMatchObject({
      provider: {
        name: 'ollama',
        model: 'vision-model',
        selectedModels: { ollama: 'vision-model' },
      },
    });
    await expect(persistProviderSelection(root, 'codex', 'gpt-5.6-sol')).resolves.toBeUndefined();
    await expect(loadRuntimeConfig(root)).resolves.toMatchObject({
      provider: {
        name: 'codex',
        model: 'gpt-5.6-sol',
        selectedModels: { ollama: 'vision-model', codex: 'gpt-5.6-sol' },
      },
    });
    await expect(persistProviderSelection(root, '', 'model')).rejects.toThrow(
      'Provider and model are required',
    );
  });

  it('loads the generated Matrix environment without overriding explicit process values', async () => {
    const root = await makeRoot();
    const tokenName = 'NUAAI_MATRIX_ACCESS_TOKEN';
    const userName = 'NUAAI_MATRIX_USER_ID';
    const previousToken = process.env[tokenName];
    const previousUser = process.env[userName];
    try {
      delete process.env[tokenName];
      process.env[userName] = '@explicit:example.org';
      await writeFile(
        join(workspaceDirectory(root), 'matrix.env'),
        'NUAAI_MATRIX_ACCESS_TOKEN=fixture-access-token\nNUAAI_MATRIX_USER_ID=@file:example.org\n',
        { mode: 0o600 },
      );

      await expect(loadRuntimeConfig(root)).resolves.toMatchObject({
        matrix: {
          accessToken: 'fixture-access-token',
          userId: '@explicit:example.org',
        },
      });
    } finally {
      if (previousToken === undefined) delete process.env[tokenName];
      else process.env[tokenName] = previousToken;
      if (previousUser === undefined) delete process.env[userName];
      else process.env[userName] = previousUser;
    }
  });

  it('encrypts, decrypts, rotates, and rejects malformed secrets', () => {
    const encoded = encryptSecret('top-secret', 'old-master');
    expect(encoded.startsWith('v1.')).toBe(true);
    expect(decryptSecret(encoded, 'old-master')).toBe('top-secret');
    expect(decryptSecret(rotateSecret(encoded, 'old-master', 'new-master'), 'new-master')).toBe(
      'top-secret',
    );
    expect(() => encryptSecret('x', ' ')).toThrow('Master key is required');
    expect(() => decryptSecret('bad', 'old-master')).toThrow('Invalid encrypted secret format');
    expect(() => decryptSecret(encoded, 'wrong-master')).toThrow();
    expect(() => decryptSecret(`${encoded}.extra`, 'old-master')).toThrow(
      'Invalid encrypted secret format',
    );
  });

  it('redacts bearer tokens, API keys, nested values, and permissions', () => {
    expect(redactText('Bearer abc.def and sk-12345678')).toBe('Bearer [REDACTED] and [REDACTED]');
    expect(
      redactValue({ token: 'secret', nested: [{ password: 'hidden' }, 'Bearer abc'] }),
    ).toEqual({ token: '[REDACTED]', nested: [{ password: '[REDACTED]' }, 'Bearer [REDACTED]'] });
    expect(redactValue({ accessToken: 123_456, authorization: 42 })).toEqual({
      accessToken: '[REDACTED]',
      authorization: '[REDACTED]',
    });
    assertPermission(permissive, 'read');
    expect(() =>
      assertPermission({ approved: new Set(['read']), capabilities: {} }, 'write'),
    ).toThrow('Permission required: write');
    const event = createEvent('message.created', { authorization: 'Bearer abc', text: 'safe' });
    expect(event.schemaVersion).toBe(1);
    expect(event.source).toBe('daemon');
    expect(event.payload).toEqual({ authorization: '[REDACTED]', text: 'safe' });
  });

  it('persists the runtime identity and reuses it', async () => {
    const root = await makeRoot();
    const first = ensureRuntimeIdentity(root);
    const second = ensureRuntimeIdentity(root);
    expect(first).toEqual(second);
    expect(first.token).toContain('.');
    expect(validateToken(first.token, first.secret)).toMatchObject({ sub: 'local-client' });
  });

  it('rotates an expired runtime token while preserving the runtime secret', async () => {
    const root = await makeRoot();
    const first = ensureRuntimeIdentity(root);
    const expired = createToken({ sub: 'local-client', exp: 1 }, first.secret, 2_000);
    await writeFile(
      join(workspaceDirectory(root), 'runtime.json'),
      `${JSON.stringify({ secret: first.secret, token: expired }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const refreshed = ensureRuntimeIdentity(root);
    expect(refreshed.secret).toBe(first.secret);
    expect(refreshed.token).not.toBe(expired);
    expect(validateToken(refreshed.token, refreshed.secret)).toMatchObject({ sub: 'local-client' });
  });

  it('mints a five-minute browser-pairing token without replacing the runtime bearer', async () => {
    const root = await makeRoot();
    const runtime = ensureRuntimeIdentity(root);
    const now = 1_800_000_000_000;

    const pairing = createBrowserPairingToken(root, now);

    expect(pairing).not.toBe(runtime.token);
    expect(validateToken(pairing, runtime.secret, now)).toMatchObject({
      sub: 'browser-pairing',
      purpose: 'browser-pairing',
      iat: Math.floor(now / 1_000),
      exp: Math.floor(now / 1_000) + 300,
    });
    expect(ensureRuntimeIdentity(root).token).toBe(runtime.token);
  });

  it('prevents duplicate daemon locks and releases ownership safely', async () => {
    const root = await makeRoot();
    const first = await acquireDaemonLock(root);
    await expect(acquireDaemonLock(root)).rejects.toThrow('Daemon already running');
    await first.release();
    const second = await acquireDaemonLock(root);
    await second.release();
  });

  it('acquires exactly one daemon lock in an uninitialized workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-uninitialized-lock-'));
    roots.push(root);
    const attempts = await Promise.allSettled([acquireDaemonLock(root), acquireDaemonLock(root)]);
    const acquired = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireDaemonLock>>> =>
        attempt.status === 'fulfilled',
    );
    expect(acquired).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    await acquired[0].value.release();
  });

  it('rejects a second daemon before creating identity, config, or database state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-second-daemon-'));
    roots.push(root);
    await mkdir(workspaceDirectory(root), { recursive: true });
    const owner = await acquireDaemonLock(root);

    await expect(startDaemon(root)).rejects.toThrow('Daemon already running');
    for (const name of ['config.json', 'runtime.json', 'memory.db']) {
      await expect(stat(join(workspaceDirectory(root), name))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    await owner.release();
  });

  it('reclaims malformed and stale daemon locks without deleting another owner', async () => {
    const root = await makeRoot();
    const lockPath = join(root, '.nuaai', 'daemon.lock');
    expect(await daemonLockExists(root)).toBe(false);

    await writeFile(lockPath, 'not-json\n');
    await expect(acquireDaemonLock(root)).rejects.toThrow('not readable');
    await utimes(lockPath, new Date(0), new Date(0));
    const malformed = await acquireDaemonLock(root);
    expect(await daemonLockExists(root)).toBe(true);
    await malformed.release();

    await writeFile(lockPath, JSON.stringify({ pid: 0, owner: 'stale' }));
    await expect(acquireDaemonLock(root)).rejects.toThrow('not readable');
    await utimes(lockPath, new Date(0), new Date(0));
    const incomplete = await acquireDaemonLock(root);
    await incomplete.release();

    await writeFile(lockPath, JSON.stringify({ pid: 0, owner: 'stale', startedAt: 1 }));
    const invalidPid = await acquireDaemonLock(root);
    await invalidPid.release();

    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, owner: 'stale', startedAt: 1 }));
    const stale = await acquireDaemonLock(root);
    await stale.release();

    const owned = await acquireDaemonLock(root);
    await writeFile(lockPath, JSON.stringify({ pid: 0, owner: 'other', startedAt: 1 }));
    await owned.release();
    expect(await daemonLockExists(root)).toBe(true);
    await unlink(lockPath);
    expect(await daemonLockExists(root)).toBe(false);
  });

  it('loads both identity files once and bounds oversized instructions', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'AGENTS.md'), 'workspace rules');
    await writeFile(join(root, 'SOUL.md'), 'agent identity');
    expect(loadSessionIdentity(root)).toContain('## AGENTS.md\nworkspace rules');
    expect(loadSessionIdentity(root)).toContain('## SOUL.md\nagent identity');

    await writeFile(join(root, 'SOUL.md'), 'x'.repeat(12_001));
    const bounded = loadSessionIdentity(root);
    expect(bounded).toContain('[truncated by NUAAI]');
    expect(Buffer.byteLength(bounded, 'utf8')).toBeGreaterThan(12_000);
  });

  it('returns a truthful empty identity when workspace instruction files are absent', async () => {
    const root = await makeRoot();
    expect(loadSessionIdentity(root)).toBe('No AGENTS.md or SOUL.md was present at session start.');
  });
});

describe('SQLite persistence and vector memory', () => {
  it('persists sessions, messages, runs, events, memory, secrets, and schedules', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    expect((await stat(workspaceDirectory(root))).mode & 0o777).toBe(0o700);
    expect((await stat(join(workspaceDirectory(root), 'memory.db'))).mode & 0o777).toBe(0o600);
    expect(
      (
        store.database.raw
          .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
          .get() as {
          value: string;
        }
      ).value,
    ).toBe('7');
    const legacyRoot = await makeRoot();
    await mkdir(workspaceDirectory(legacyRoot), { recursive: true });
    const legacyDb = new Database(join(workspaceDirectory(legacyRoot), 'memory.db'));
    legacyDb.exec(`
      CREATE TABLE plugins (
        name TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        capabilities TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '2');
    `);
    legacyDb.close();
    const upgraded = openAppDatabase(legacyRoot);
    expect(
      (
        upgraded.raw
          .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
          .get() as { value: string }
      ).value,
    ).toBe('7');
    expect(
      (upgraded.raw.prepare('PRAGMA table_info(plugins)').all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).toEqual(
      expect.arrayContaining(['api_version', 'entry', 'dependencies', 'config', 'last_error']),
    );
    upgraded.raw.close();
    const rawMemory = openMemoryDatabase(await makeRoot());
    const memoryId = addMemory(rawMemory, 'legacy memory', 10);
    expect(listMemories(rawMemory)).toEqual([
      { id: memoryId, content: 'legacy memory', createdAt: 10 },
    ]);
    rawMemory.close();

    const created = store.createSession('Persistence test', 100);
    expect(store.getSession(created.session.id)?.title).toBe('Persistence test');
    expect(store.listThreads(created.session.id)).toHaveLength(1);
    const message = store.addMessage(
      created.thread.id,
      'user',
      'hello',
      'deterministic',
      'local-test',
      101,
    );
    expect(store.listMessages(created.thread.id)).toEqual([message]);
    for (let index = 0; index < 5; index += 1)
      store.addMessage(
        created.thread.id,
        'user',
        `recent-${index}`,
        'deterministic',
        'local-test',
        110 + index,
      );
    expect(store.listMessages(created.thread.id, 3).map((entry) => entry.content)).toEqual([
      'recent-2',
      'recent-3',
      'recent-4',
    ]);

    const event = store.appendEvent(
      createEvent(
        'message.created',
        { token: 'do-not-store', content: 'hello' },
        {
          sessionId: created.session.id,
          threadId: created.thread.id,
        },
      ),
    );
    expect(store.listEvents(0)).toHaveLength(1);
    expect(store.listEvents(0)[0]).toMatchObject({
      id: event.id,
      payload: { token: '[REDACTED]' },
    });

    const crowded = store.createSession('Crowded event history', 200);
    const selected = store.createSession('Selected event history', 201);
    for (let index = 0; index < 1_005; index += 1)
      store.appendEvent(
        createEvent(
          'message.created',
          { content: `irrelevant-${index}` },
          {
            sessionId: crowded.session.id,
            threadId: crowded.thread.id,
          },
        ),
      );
    const selectedEvents = Array.from({ length: 3 }, (_, index) =>
      store.appendEvent(
        createEvent(
          'message.created',
          { content: `selected-${index}` },
          {
            sessionId: selected.session.id,
            threadId: selected.thread.id,
          },
        ),
      ),
    );

    const firstSelectedPage = store.listEventsForSession(selected.session.id, 0, 2);
    expect(firstSelectedPage).toMatchObject({
      events: selectedEvents.slice(0, 2),
      hasMore: true,
      nextCursor: selectedEvents[1]?.id,
    });
    expect(
      store.listEventsForSession(selected.session.id, firstSelectedPage.nextCursor, 2),
    ).toEqual({
      events: selectedEvents.slice(2),
      hasMore: false,
      nextCursor: selectedEvents[2]?.id,
    });
    expect(store.listEventsForThread(selected.thread.id, 0, 10)).toEqual({
      events: selectedEvents,
      hasMore: false,
      nextCursor: selectedEvents[2]?.id,
    });
    expect(store.eventHighWaterForSession(selected.session.id)).toBe(selectedEvents[2]?.id);
    expect(store.eventHighWaterForSession(crowded.session.id)).toBeLessThan(
      selectedEvents[0]?.id ?? 0,
    );

    const run = store.createRun(
      created.thread.id,
      'run input',
      'deterministic',
      'local-test',
      'corr',
      102,
    );
    expect(store.listActiveRuns()).toEqual([run]);
    store.updateRun(run.id, { status: 'running', output: 'partial' }, 103);
    store.requestRunCancel(run.id);
    expect(store.getRun(run.id)).toMatchObject({
      status: 'running',
      output: 'partial',
      cancelRequested: true,
    });
    expect(store.listActiveRuns()).toHaveLength(1);

    const vector = Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
    store.storeMemory('memory-a', 'vector memory', vector, { token: 'private' }, 104);
    store.storeMemory('memory-b', 'short embedding', [1, 0, 0], {}, 105);
    expect(store.searchMemoryRows()).toHaveLength(2);
    expect(store.searchMemory(vector, 4)[0]).toMatchObject({
      id: 'memory-a',
      content: 'vector memory',
    });
    expect(store.searchMemory([1, 0], 4)).toEqual([]);
    expect(store.searchMemoryRows().find((memory) => memory.id === 'memory-a')?.metadata).toEqual({
      token: '[REDACTED]',
    });

    store.putSecret('API_TOKEN', 'v1.encrypted', 106);
    expect(store.hasSecret('API_TOKEN')).toBe(true);
    expect(store.getSecretCiphertext('API_TOKEN')).toBe('v1.encrypted');
    store.deleteSecret('API_TOKEN');
    expect(store.hasSecret('API_TOKEN')).toBe(false);

    store.saveSchedule(
      {
        id: 'schedule-a',
        name: 'test schedule',
        type: 'manual',
        expression: '',
        agentInput: 'do work',
        enabled: true,
        nextRunAt: null,
        lastRunAt: null,
      },
      107,
    );
    expect(store.listSchedules()[0]).toMatchObject({ id: 'schedule-a', enabled: 1 });
    store.updateSchedule('schedule-a', { enabled: false, nextRunAt: null });
    expect(store.listSchedules()[0]).toMatchObject({ enabled: 0, nextRunAt: null });
    expect(() => store.updateSchedule('missing', { enabled: false })).toThrow('Unknown schedule');
  });

  it('selects the newest thread run deterministically and snapshots its latest activity', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const created = store.createSession('Run snapshots', 100);
    const first = store.createRun(
      created.thread.id,
      'first',
      'deterministic',
      'local-test',
      'snapshot-first',
      200,
    );
    const latest = store.createRun(
      created.thread.id,
      'latest',
      'deterministic',
      'local-test',
      'snapshot-latest',
      200,
    );
    expect(store.getLatestRun(created.thread.id)?.id).toBe(latest.id);

    for (let index = 0; index < 4; index += 1)
      store.appendEvent(
        createEvent(
          index === 0 ? 'run.started' : 'model.delta',
          { text: `delta-${index}` },
          {
            sessionId: created.session.id,
            threadId: created.thread.id,
            runId: latest.id,
          },
        ),
      );
    store.appendEvent(
      createEvent(
        'run.completed',
        { output: 'first result' },
        {
          sessionId: created.session.id,
          threadId: created.thread.id,
          runId: first.id,
        },
      ),
    );

    const snapshot = store.listRecentEventsForRun(latest.id, 2);
    expect(snapshot.map((event) => event.payload.text)).toEqual(['delta-2', 'delta-3']);
    expect(snapshot[0]?.id).toBeLessThan(snapshot[1]?.id ?? 0);
  });

  it('paginates older thread messages by a stable row cursor when timestamps tie', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const created = store.createSession('Message pages', 100);
    for (let index = 0; index < 5; index += 1)
      store.addMessage(created.thread.id, 'user', `message-${index}`, undefined, undefined, 200);

    const newest = store.listMessagePage(created.thread.id, undefined, 2);
    expect(newest.messages.map((message) => message.content)).toEqual(['message-3', 'message-4']);
    expect(newest.hasMore).toBe(true);
    const middle = store.listMessagePage(created.thread.id, newest.nextCursor, 2);
    expect(middle.messages.map((message) => message.content)).toEqual(['message-1', 'message-2']);
    expect(middle.hasMore).toBe(true);
    const oldest = store.listMessagePage(created.thread.id, middle.nextCursor, 2);
    expect(oldest.messages.map((message) => message.content)).toEqual(['message-0']);
    expect(oldest.hasMore).toBe(false);
  });

  it('lists the running thread owner before queued follow-ups and excludes other threads', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const created = store.createSession('Thread run queue', 100);
    const otherThread = store.createThread(created.session.id, 'Other', 101);
    const running = store.createRun(
      created.thread.id,
      'running',
      'codex',
      'gpt-test',
      'queue-running',
      200,
    );
    store.updateRun(running.id, { status: 'running' }, 201);
    const queued = store.createRun(
      created.thread.id,
      'queued',
      'codex',
      'gpt-test',
      'queue-follow-up',
      202,
    );
    store.createRun(otherThread.id, 'other', 'codex', 'gpt-test', 'queue-other', 203);

    expect(store.listActiveRunsForThread(created.thread.id).map((run) => run.id)).toEqual([
      running.id,
      queued.id,
    ]);
  });

  it('archives duplicate legacy source bindings before creating unique indexes', async () => {
    const root = await makeRoot();
    const databasePath = join(workspaceDirectory(root), 'memory.db');
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        source_key TEXT,
        context TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        source_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES ('older', 'Older', 'active', 'matrix:source', '', 1, 1);
      INSERT INTO sessions VALUES ('newer', 'Newer', 'active', 'matrix:source', '', 2, 2);
      INSERT INTO threads VALUES ('older-thread', 'older', 'Main', 'matrix:source:main', 1, 1);
      INSERT INTO threads VALUES ('newer-thread', 'newer', 'Main', 'matrix:source:main', 2, 2);
    `);
    legacy.close();

    const upgraded = openAppDatabase(root);
    const sessions = upgraded.raw
      .prepare('SELECT id, source_key AS sourceKey FROM sessions ORDER BY updated_at DESC')
      .all() as Array<{ id: string; sourceKey: string }>;
    const threads = upgraded.raw
      .prepare('SELECT id, source_key AS sourceKey FROM threads ORDER BY updated_at DESC')
      .all() as Array<{ id: string; sourceKey: string }>;

    expect(sessions[0]).toEqual({ id: 'newer', sourceKey: 'matrix:source' });
    expect(sessions[1]?.sourceKey).toMatch(/^matrix:source:history:older:legacy:/);
    expect(threads[0]).toEqual({ id: 'newer-thread', sourceKey: 'matrix:source:main' });
    expect(threads[1]?.sourceKey).toMatch(/^matrix:source:main:history:older-thread:legacy:/);
    upgraded.raw.close();
  });
});

describe('secrets manager, workspace tools, skills, and plugins', () => {
  it('stores secrets encrypted and rotates the encrypted records', async () => {
    const root = await makeRoot();
    const previous = process.env.NUAAI_MASTER_KEY;
    process.env.NUAAI_MASTER_KEY = 'old-master-key';
    try {
      const store = makeStore(root);
      const manager = new SecretsManager(store, root);
      manager.set('service-token', 'plaintext-value');
      expect(manager.has('service-token')).toBe(true);
      expect(manager.get('service-token')).toBe('plaintext-value');
      expect(manager.listNames()).toEqual(['service-token']);
      const ciphertext = store.getSecretCiphertext('service-token');
      expect(ciphertext).not.toContain('plaintext-value');
      manager.rotate('old-master-key', 'new-master-key');
      process.env.NUAAI_MASTER_KEY = 'new-master-key';
      expect(new SecretsManager(store, root).get('service-token')).toBe('plaintext-value');
      manager.delete('service-token');
      expect(manager.listNames()).toEqual([]);
      expect(manager.get('missing')).toBeUndefined();
      manager.rotate('old-master-key', 'new-master-key');
      expect(() => manager.set('', 'x')).toThrow('Secret name and value are required');
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'NUAAI_MASTER_KEY');
      else process.env.NUAAI_MASTER_KEY = previous;
    }
  });

  it('creates a local master key when no environment key is configured', async () => {
    const root = await makeRoot();
    const previous = process.env.NUAAI_MASTER_KEY;
    Reflect.deleteProperty(process.env, 'NUAAI_MASTER_KEY');
    try {
      const manager = new SecretsManager(makeStore(root), root);
      manager.set('generated-key', 'value');
      expect(manager.get('generated-key')).toBe('value');
    } finally {
      if (previous !== undefined) process.env.NUAAI_MASTER_KEY = previous;
    }
  });

  it('executes secure workspace tools and enforces permissions', async () => {
    const root = await makeRoot();
    const tools = new ToolRegistry(root);
    expect(tools.list()).toHaveLength(8);
    expect(tools.schemas().map((tool) => tool.name)).toContain('workspace.command');
    await tools.execute(
      'workspace.write',
      { path: 'notes.txt', content: 'hello world' },
      {
        root,
        permissions: permissive,
      },
    );
    await expect(
      tools.execute(
        'workspace.read',
        { path: 'notes.txt' },
        {
          root,
          permissions: permissive,
        },
      ),
    ).resolves.toBe('hello world');
    await expect(
      tools.execute(
        'workspace.search',
        { query: 'world' },
        {
          root,
          permissions: permissive,
        },
      ),
    ).resolves.toEqual([expect.objectContaining({ file: 'notes.txt', line: 1 })]);
    await expect(
      tools.execute('workspace.list', {}, { root, permissions: permissive }),
    ).resolves.toContain('notes.txt');
    await expect(
      tools.execute(
        'workspace.command',
        { command: 'printf', args: ['ok'] },
        {
          root,
          permissions: permissive,
          timeoutMs: 5_000,
        },
      ),
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' });
    await expect(
      tools.execute(
        'workspace.write',
        { path: 'blocked.txt', content: 'x' },
        {
          root,
          permissions: { approved: new Set(['read']), capabilities: {} },
        },
      ),
    ).rejects.toThrow('Permission required: write');
    await expect(tools.execute('missing', {}, { root, permissions: permissive })).rejects.toThrow(
      'Unknown tool',
    );
    await expect(
      tools.execute('workspace.read', { path: '' }, { root, permissions: permissive }),
    ).rejects.toThrow();
    expect(() => tools.register(tools.list()[0])).toThrow('Tool already registered');
    await expect(runWorkspaceCommand('sh', [], root)).rejects.toThrow('not allowlisted');
    await expect(assertSafeExistingPath(root, 'missing.txt')).resolves.toBe(
      join(root, 'missing.txt'),
    );

    const searchStack = new SearchStack({
      searxng: {
        search: async () => [
          { title: 'result', url: 'https://example.com', snippet: '', source: 'searxng' },
        ],
      },
      browser: {
        open: async () => ({ url: 'https://example.com', title: 'page', text: 'body' }),
      },
      urlPolicy: new PublicOutboundUrlPolicy(async () => [{ address: '93.184.216.34', family: 4 }]),
    });
    const networkTools = new ToolRegistry(root, searchStack, { browserEnabled: false });
    const networkPermissions: PermissionContext = {
      ...permissive,
      capabilities: { ...permissive.capabilities, network: true },
    };
    expect(networkTools.schemas().map((tool) => tool.name)).toContain('web.search');
    expect(networkTools.schemas().map((tool) => tool.name)).not.toContain('web.fetch');
    expect(networkTools.schemas().map((tool) => tool.name)).not.toContain('browser.open');
    await expect(
      networkTools.execute(
        'web.search',
        { query: 'nuaai' },
        { root, permissions: networkPermissions },
      ),
    ).resolves.toHaveLength(1);
    await expect(
      networkTools.execute(
        'web.fetch',
        { url: 'https://example.com' },
        { root, permissions: networkPermissions },
      ),
    ).rejects.toThrow('Unknown tool');
    await expect(
      networkTools.execute(
        'web.search',
        { query: 'nuaai' },
        {
          root,
          permissions: { approved: new Set(['read']), capabilities: { filesystem: true } },
        },
      ),
    ).rejects.toThrow('Network capability required');
    await expect(
      networkTools.execute(
        'browser.open',
        { url: 'https://example.com' },
        { root, permissions: permissive },
      ),
    ).rejects.toThrow('Unknown tool');
    await expect(readWorkspaceFile(root, '.nuaai/skills')).rejects.toThrow(
      'Protected workspace file',
    );
    await expect(assertSafeExistingPath(root, '../outside')).rejects.toThrow(
      'Path escapes workspace',
    );
    await symlink('/tmp', join(workspaceDirectory(root), 'outside-link'));
    await expect(assertSafeExistingPath(workspaceDirectory(root), 'outside-link')).rejects.toThrow(
      'Path escapes workspace',
    );
    await expect(searchWorkspace(root, '   ')).rejects.toThrow('Search query is required');
    await expect(runWorkspaceCommand('/bin/sh', [], root)).rejects.toThrow(
      'Absolute command is not allowlisted',
    );
    await expect(runWorkspaceCommand('printf "hello world"', [], root)).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'hello world',
    });
    await expect(runWorkspaceCommand('printf hello\\ world', [], root)).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'hello world',
    });
    await expect(runWorkspaceCommand('printf hi > output.txt', [], root)).rejects.toThrow(
      'Shell operators are not supported',
    );
    await expect(runWorkspaceCommand('cat', ['missing-command-file'], root)).resolves.toMatchObject(
      {
        exitCode: 1,
      },
    );
    expect(await listWorkspaceFiles(root)).toContain('notes.txt');
    expect(await readWorkspaceFile(root, 'notes.txt')).toBe('hello world');
    expect(await searchWorkspace(root, 'WORLD')).toEqual([
      expect.objectContaining({ file: 'notes.txt' }),
    ]);
    expect(textDiff('a\n', 'b\n').map((change) => change.value)).toEqual(['a\n', 'b\n']);
  });

  it('loads trusted filesystem skills and refuses untrusted ones', async () => {
    const root = await makeRoot();
    const skillsRoot = join(workspaceDirectory(root), 'skills');
    await mkdir(join(skillsRoot, 'trusted-skill'), { recursive: true });
    await mkdir(join(skillsRoot, 'untrusted-skill'), { recursive: true });
    await writeFile(
      join(skillsRoot, 'trusted-skill', 'manifest.json'),
      JSON.stringify({
        name: 'trusted-skill',
        description: 'Trusted',
        version: '1.0.0',
        trusted: true,
      }),
    );
    await writeFile(
      join(skillsRoot, 'trusted-skill', 'index.mjs'),
      'export async function execute(input) { return { input, loaded: true }; }\n',
    );
    await writeFile(
      join(skillsRoot, 'untrusted-skill', 'manifest.json'),
      JSON.stringify({
        name: 'untrusted-skill',
        description: 'Untrusted',
        version: '1.0.0',
        trusted: false,
      }),
    );
    const store = makeStore(root);
    const registry = new SkillRegistry();
    const loaded = await loadFilesystemSkills(root, registry, store);
    expect(loaded.map((skill) => skill.name)).toEqual(['trusted-skill']);
    await expect(registry.dispatch('trusted-skill', { ok: true })).resolves.toEqual({
      input: { ok: true },
      loaded: true,
    });
    expect(registry.has('untrusted-skill')).toBe(false);
    expect(store.listEvents().map((event) => event.type)).toEqual(
      expect.arrayContaining(['skill.loaded', 'skill.failed']),
    );
    expect(() =>
      registry.replace({ name: '', description: 'bad', input: z.unknown(), execute: () => null }),
    ).toThrow('Skill name is required');
    expect(() =>
      registry.replace({
        name: 'trusted-skill',
        description: 'replace',
        input: z.unknown(),
        execute: () => null,
      }),
    ).not.toThrow();
  });

  it('rejects trusted skills without an execute export', async () => {
    const root = await makeRoot();
    const skillRoot = join(workspaceDirectory(root), 'skills', 'broken-skill');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, 'manifest.json'),
      JSON.stringify({
        name: 'broken-skill',
        description: 'Broken',
        version: '1.0.0',
        trusted: true,
      }),
    );
    await writeFile(join(skillRoot, 'index.mjs'), 'export const nope = true;\n');
    await expect(loadFilesystemSkills(root, new SkillRegistry(), makeStore(root))).rejects.toThrow(
      'Skill entry must export execute',
    );
  });

  it('loads trusted plugins and records refused plugins', async () => {
    const root = await makeRoot();
    const pluginsRoot = join(workspaceDirectory(root), 'plugins');
    await mkdir(join(pluginsRoot, 'trusted-plugin'), { recursive: true });
    await mkdir(join(pluginsRoot, 'untrusted-plugin'), { recursive: true });
    await mkdir(join(pluginsRoot, 'broken-plugin'), { recursive: true });
    await mkdir(join(pluginsRoot, 'failing-plugin'), { recursive: true });
    await mkdir(join(pluginsRoot, 'future-plugin'), { recursive: true });
    await mkdir(join(pluginsRoot, 'dependent-plugin'), { recursive: true });
    await writeFile(
      join(pluginsRoot, 'trusted-plugin', 'manifest.json'),
      JSON.stringify({ name: 'trusted-plugin', version: '1.0.0', apiVersion: '1', trusted: true }),
    );
    await writeFile(
      join(pluginsRoot, 'trusted-plugin', 'index.mjs'),
      'export async function execute(request) { return { echoed: request.input, config: request.config }; }\n',
    );
    await writeFile(
      join(pluginsRoot, 'untrusted-plugin', 'manifest.json'),
      JSON.stringify({
        name: 'untrusted-plugin',
        version: '1.0.0',
        apiVersion: '1',
        trusted: false,
      }),
    );
    await writeFile(
      join(pluginsRoot, 'broken-plugin', 'manifest.json'),
      JSON.stringify({ name: 'broken-plugin', version: '1.0.0', apiVersion: '1', trusted: true }),
    );
    await writeFile(
      join(pluginsRoot, 'failing-plugin', 'manifest.json'),
      JSON.stringify({ name: 'failing-plugin', version: '1.0.0', apiVersion: '1', trusted: true }),
    );
    await writeFile(
      join(pluginsRoot, 'failing-plugin', 'index.mjs'),
      "export async function execute() { throw new Error('plugin boom'); }\n",
    );
    await writeFile(
      join(pluginsRoot, 'future-plugin', 'manifest.json'),
      JSON.stringify({ name: 'future-plugin', version: '1.0.0', apiVersion: '2', trusted: true }),
    );
    await writeFile(
      join(pluginsRoot, 'dependent-plugin', 'manifest.json'),
      JSON.stringify({
        name: 'dependent-plugin',
        version: '1.0.0',
        apiVersion: '1',
        dependencies: { 'missing-plugin': '^1.0.0' },
        trusted: true,
      }),
    );
    const store = makeStore(root);
    const registry = new PluginRegistry(root, store);
    await expect(registry.load()).resolves.toEqual([
      expect.objectContaining({ name: 'failing-plugin', entry: 'index.mjs' }),
      expect.objectContaining({ name: 'trusted-plugin', entry: 'index.mjs' }),
    ]);
    expect(registry.list()).toHaveLength(2);
    expect(store.listPlugins()).toHaveLength(2);
    expect(registry.health()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'broken-plugin', loaded: false, enabled: false }),
        expect.objectContaining({ name: 'dependent-plugin', loaded: false, enabled: false }),
        expect.objectContaining({ name: 'future-plugin', loaded: false, enabled: false }),
        expect.objectContaining({ name: 'untrusted-plugin', loaded: false, enabled: false }),
      ]),
    );
    await expect(registry.execute('trusted-plugin', 'hello')).resolves.toEqual({
      echoed: 'hello',
      config: {},
    });
    await expect(registry.execute('failing-plugin', 'hello')).rejects.toThrow('plugin boom');
    expect(
      store.listPlugins().find((plugin) => plugin.name === 'failing-plugin')?.lastError,
    ).toContain('plugin boom');
    expect(registry.health()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'failing-plugin',
          error: expect.stringContaining('plugin boom'),
        }),
      ]),
    );
    registry.configure('trusted-plugin', { mode: 'persisted' });
    registry.disable('trusted-plugin');
    expect(store.listPlugins().find((plugin) => plugin.name === 'trusted-plugin')).toMatchObject({
      enabled: false,
      config: { mode: 'persisted' },
    });
    await expect(registry.reload('trusted-plugin')).resolves.toHaveLength(2);
    expect(registry.list().find((plugin) => plugin.name === 'trusted-plugin')?.config).toEqual({
      mode: 'persisted',
    });
    registry.enable('trusted-plugin');
    await expect(registry.execute('trusted-plugin', 'blocked')).resolves.toMatchObject({
      echoed: 'blocked',
    });
    registry.disable('trusted-plugin');
    await expect(registry.execute('trusted-plugin', { input: 'blocked' })).rejects.toThrow(
      'Plugin trusted-plugin is disabled',
    );
    registry.unload('trusted-plugin');
    registry.unload('failing-plugin');
    expect(registry.list()).toHaveLength(0);
    expect(store.listPlugins()).toHaveLength(0);
  });
  it('isolates malformed entries and child-process boundary failures', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const pluginsRoot = join(workspaceDirectory(root), 'plugins');
    const addPlugin = async (
      directory: string,
      manifest: Record<string, unknown>,
      entry?: string,
    ): Promise<void> => {
      const pluginRoot = join(pluginsRoot, directory);
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(join(pluginRoot, 'manifest.json'), JSON.stringify(manifest));
      if (entry !== undefined)
        await writeFile(join(pluginRoot, String(manifest.entry ?? 'index.mjs')), entry);
    };
    await addPlugin('malformed', {}, '{not-json');
    await writeFile(join(pluginsRoot, 'malformed', 'manifest.json'), '{not-json');
    await addPlugin(
      'traversal',
      {
        name: 'traversal',
        version: '1.0.0',
        apiVersion: '1',
        trusted: true,
        entry: '../escape.mjs',
      },
      'export const execute = async () => null;',
    );
    await addPlugin('not-file', {
      name: 'not-file',
      version: '1.0.0',
      apiVersion: '1',
      trusted: true,
      entry: 'directory',
    });
    await mkdir(join(pluginsRoot, 'not-file', 'directory'));
    await addPlugin(
      'base-plugin',
      { name: 'base-plugin', version: '1.0.0', apiVersion: '1', trusted: true },
      'export const execute = async () => ({ ok: true });',
    );
    await addPlugin(
      'incompatible-plugin',
      {
        name: 'incompatible-plugin',
        version: '1.0.0',
        apiVersion: '1',
        trusted: true,
        dependencies: { 'base-plugin': '^2.0.0' },
      },
      'export const execute = async () => ({ ok: true });',
    );
    await addPlugin(
      'module-error',
      { name: 'module-error', version: '1.0.0', apiVersion: '1', trusted: true },
      "throw new Error('module load crash');",
    );
    await addPlugin(
      'malformed-output',
      { name: 'malformed-output', version: '1.0.0', apiVersion: '1', trusted: true },
      "export const execute = async () => { process.stdout.write('not-json'); return 'ignored'; };",
    );
    await addPlugin(
      'empty-output',
      { name: 'empty-output', version: '1.0.0', apiVersion: '1', trusted: true },
      'export const execute = async () => { process.exit(0); };',
    );
    await addPlugin(
      'huge-output',
      { name: 'huge-output', version: '1.0.0', apiVersion: '1', trusted: true },
      "export const execute = async () => { process.stdout.write('x'.repeat(1000001)); return 'ignored'; };",
    );
    await mkdir(join(pluginsRoot, 'duplicate-a'), { recursive: true });
    await mkdir(join(pluginsRoot, 'duplicate-b'), { recursive: true });
    for (const directory of ['duplicate-a', 'duplicate-b']) {
      await writeFile(
        join(pluginsRoot, directory, 'manifest.json'),
        JSON.stringify({ name: 'duplicate', version: '1.0.0', apiVersion: '1', trusted: true }),
      );
      await writeFile(
        join(pluginsRoot, directory, 'index.mjs'),
        'export const execute = async () => ({ duplicate: true });',
      );
    }

    await registryLoadAndAssertFailures();

    async function registryLoadAndAssertFailures(): Promise<void> {
      const registry = new PluginRegistry(root, store);
      const loaded = await registry.load();
      expect(loaded.map((plugin) => plugin.name)).toEqual(
        expect.arrayContaining([
          'base-plugin',
          'duplicate',
          'empty-output',
          'huge-output',
          'malformed-output',
          'module-error',
        ]),
      );
      expect(registry.health()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'incompatible-plugin', loaded: false }),
          expect.objectContaining({ name: 'malformed', loaded: false }),
          expect.objectContaining({ name: 'not-file', loaded: false }),
          expect.objectContaining({ name: 'traversal', loaded: false }),
        ]),
      );
      await expect(registry.execute('module-error', null)).rejects.toThrow('module load crash');
      await expect(registry.execute('malformed-output', null)).rejects.toThrow('Unexpected token');
      await expect(registry.execute('empty-output', null)).rejects.toThrow('no result');
      await expect(registry.execute('huge-output', null)).rejects.toThrow('1 MB limit');
      await expect(registry.execute('missing-plugin', null)).rejects.toThrow('Unknown plugin');
      await expect(registry.reload('missing-plugin')).rejects.toThrow('Unknown plugin');
      expect(() => registry.enable('missing-plugin')).toThrow('Unknown plugin');
      expect(() => registry.configure('missing-plugin', {})).toThrow('Unknown plugin');
      expect(() => registry.unload('missing-plugin')).toThrow('Unknown plugin');
      expect(() => registry.disable('missing-plugin')).toThrow('Unknown plugin');
    }
  });
});

describe('providers and scheduler', () => {
  it('runs the deterministic provider and registers it only in test mode', async () => {
    const previous = process.env.NUAAI_TEST_MODE;
    process.env.NUAAI_TEST_MODE = '1';
    try {
      const provider = new DeterministicProvider();
      const events: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({ model: 'local-test', messages: [] }))
        events.push(event);
      expect(events).toEqual([
        { type: 'delta', text: 'NUAAI deterministic test response' },
        { type: 'done', text: 'NUAAI deterministic test response' },
      ]);
      const toolEvents: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: 'local-test',
        messages: [{ role: 'user', content: 'browser tool smoke' }],
      }))
        toolEvents.push(event);
      expect(toolEvents[0]).toMatchObject({ type: 'tool_call', name: 'workspace.list' });
      const writeEvents: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: 'local-test',
        messages: [{ role: 'user', content: 'browser write smoke' }],
      }))
        writeEvents.push(event);
      expect(writeEvents[0]).toMatchObject({
        type: 'tool_call',
        name: 'workspace.write',
        arguments: { path: 'work-sample-output.txt', content: 'agentic-write-ok' },
      });
      const markdownEvents: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: 'local-test',
        messages: [{ role: 'user', content: 'browser markdown smoke' }],
      }))
        markdownEvents.push(event);
      expect(markdownEvents).toEqual([
        {
          type: 'delta',
          text: '## Verified output\n\n| Check | Result |\n| --- | --- |\n| Renderer | Passed |\n\n```ts\nconst answer = 42;\n```\n\n<script>alert("nope")</script>',
        },
        {
          type: 'done',
          text: '## Verified output\n\n| Check | Result |\n| --- | --- |\n| Renderer | Passed |\n\n```ts\nconst answer = 42;\n```\n\n<script>alert("nope")</script>',
        },
      ]);
      const failedEvents: ProviderStreamEvent[] = [];
      await expect(async () => {
        for await (const event of provider.stream({
          model: 'local-test',
          messages: [{ role: 'user', content: 'browser failure smoke' }],
        }))
          failedEvents.push(event);
      }).rejects.toThrow('Deterministic browser failure');
      expect(failedEvents).toEqual([]);
      const recoveredEvents: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: 'local-test',
        messages: [{ role: 'user', content: 'browser failure smoke' }],
      }))
        recoveredEvents.push(event);
      expect(recoveredEvents).toEqual([
        { type: 'delta', text: 'NUAAI deterministic test response' },
        { type: 'done', text: 'NUAAI deterministic test response' },
      ]);
      const controller = new AbortController();
      const slowEvents: ProviderStreamEvent[] = [];
      const slowStream = provider.stream({
        model: 'local-test',
        messages: [{ role: 'user', content: 'browser cancel smoke' }],
        signal: controller.signal,
      });
      const iterator = slowStream[Symbol.asyncIterator]();
      slowEvents.push((await iterator.next()).value as ProviderStreamEvent);
      controller.abort();
      expect((await iterator.next()).done).toBe(true);
      expect(slowEvents[0]).toMatchObject({ type: 'delta' });
      expect((await provider.embed('x')).length).toBe(768);
      expect(await provider.health()).toMatchObject({ available: true });
      const registry = new ProviderRegistry({
        root: process.cwd(),
        providerName: 'ollama',
        model: 'test',
        baseUrl: 'http://127.0.0.1:9',
        embeddingModel: 'embed',
        timeoutMs: 100,
      });
      expect(registry.list()).toEqual(['codex', 'deterministic', 'ollama']);
      expect(registry.get('deterministic').name).toBe('deterministic');
      expect(await registry.health()).toHaveLength(3);
      expect(await registry.catalog()).toMatchObject({ active: { name: 'ollama', model: 'test' } });
      expect(() => registry.get('missing')).toThrow('Unknown provider');
      await registry.close();
      const testMode = process.env.NUAAI_TEST_MODE;
      Reflect.deleteProperty(process.env, 'NUAAI_TEST_MODE');
      try {
        expect(
          new ProviderRegistry({
            root: process.cwd(),
            providerName: 'ollama',
            model: 'test',
            baseUrl: 'http://127.0.0.1:9',
            embeddingModel: 'embed',
            timeoutMs: 100,
          }).list(),
        ).toEqual(['codex', 'ollama']);
      } finally {
        if (testMode !== undefined) process.env.NUAAI_TEST_MODE = testMode;
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'NUAAI_TEST_MODE');
      else process.env.NUAAI_TEST_MODE = previous;
    }
  });

  it('discovers models and switches only after health and persistence succeed', async () => {
    const originalFetch = globalThis.fetch;
    const persisted: Array<{ provider: string; model: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/tags'))
        return responseJson({ models: [{ name: 'qwen3.5:latest' }, { name: 'qwen3.5:next' }] });
      return responseJson({}, 404);
    }) as typeof fetch;
    try {
      const registry = new ProviderRegistry({
        root: process.cwd(),
        providerName: 'ollama',
        model: 'qwen3.5:latest',
        baseUrl: 'http://ollama.local',
        embeddingModel: 'embed',
        timeoutMs: 5_000,
        codexEnabled: false,
        selectedModels: { ollama: 'qwen3.5:latest', codex: 'gpt-5.6-sol' },
        persistSelection: async (provider, model) => {
          persisted.push({ provider, model });
        },
      });
      expect(registry.active()).toEqual({ name: 'ollama', model: 'qwen3.5:latest' });
      expect(registry.selection('codex')).toEqual({ name: 'codex', model: 'gpt-5.6-sol' });
      expect(await registry.switch('ollama', 'qwen3.5:next')).toEqual({
        name: 'ollama',
        model: 'qwen3.5:next',
      });
      expect(persisted).toEqual([{ provider: 'ollama', model: 'qwen3.5:next' }]);
      await expect(registry.switch('ollama', 'missing')).rejects.toThrow('not available');
      expect(registry.active().model).toBe('qwen3.5:next');

      const fallbackRegistry = new ProviderRegistry({
        root: process.cwd(),
        providerName: 'codex',
        model: '',
        baseUrl: 'http://ollama.local',
        embeddingModel: 'embed',
        timeoutMs: 5_000,
        codexEnabled: false,
      });
      expect(fallbackRegistry.selection('ollama')).toEqual({
        name: 'ollama',
        model: 'qwen3.5:latest',
      });
      expect(() => fallbackRegistry.selection('missing')).toThrow('Unknown provider');

      const noPersistenceRegistry = new ProviderRegistry({
        root: process.cwd(),
        providerName: 'ollama',
        model: 'qwen3.5:latest',
        baseUrl: 'http://ollama.local',
        embeddingModel: 'embed',
        timeoutMs: 5_000,
        codexEnabled: false,
      });
      await expect(noPersistenceRegistry.switch('ollama', 'qwen3.5:next')).resolves.toEqual({
        name: 'ollama',
        model: 'qwen3.5:next',
      });

      const codexDefaultRegistry = new ProviderRegistry({
        root: process.cwd(),
        providerName: 'codex',
        model: 'gpt-default',
        baseUrl: 'http://ollama.local',
        embeddingModel: 'embed',
        timeoutMs: 5_000,
        ollamaEnabled: false,
      });
      expect(codexDefaultRegistry.selection('codex')).toEqual({
        name: 'codex',
        model: 'gpt-default',
      });
      await fallbackRegistry.close();
      await noPersistenceRegistry.close();
      await codexDefaultRegistry.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects switching to an unavailable provider without changing the active selection', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => responseJson({}, 503)) as typeof fetch;
    try {
      const registry = new ProviderRegistry({
        root: process.cwd(),
        providerName: 'ollama',
        model: 'model',
        baseUrl: 'http://ollama.local',
        embeddingModel: 'embed',
        timeoutMs: 5_000,
        codexEnabled: false,
      });
      await expect(registry.switch('ollama', 'model')).rejects.toThrow('unavailable');
      expect(registry.active()).toEqual({ name: 'ollama', model: 'model' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses Ollama streaming, modern and legacy embeddings, and health states', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    let nativeRequestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/chat')) {
        nativeRequestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return responseStream([
          JSON.stringify({ message: { content: 'Hello ' } }),
          JSON.stringify({ message: { content: 'world' }, done: true }),
        ]);
      }
      if (url.endsWith('/api/embed')) return responseJson({ embeddings: [[1, 2, 3]] });
      if (url.endsWith('/api/tags')) return responseJson({ models: [{ name: 'test-model' }] });
      return responseJson({}, 404);
    }) as typeof fetch;
    try {
      const provider = new OllamaProvider(
        {
          baseUrl: 'http://ollama.local/',
          model: 'chat-model',
          embeddingModel: 'embed-model',
        },
        5_000,
      );
      const events: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: '',
        messages: [
          { role: 'system', content: 'Follow verified policy' },
          { role: 'user', content: 'hi' },
        ],
        systemPrompt: 'Follow verified policy',
      }))
        events.push(event);
      expect(events).toEqual([
        { type: 'delta', text: 'Hello ' },
        { type: 'delta', text: 'world' },
        { type: 'done', text: 'Hello world' },
      ]);
      expect(nativeRequestBody).toEqual({
        model: 'chat-model',
        messages: [
          { role: 'system', content: 'Follow verified policy' },
          { role: 'user', content: 'hi' },
        ],
        stream: true,
        options: { num_ctx: 262_144 },
      });
      expect(await provider.embed('hi')).toEqual([1, 2, 3]);
      expect(await provider.health()).toMatchObject({ available: true, models: ['test-model'] });
      expect(calls).toContain('http://ollama.local/api/chat');
    } finally {
      globalThis.fetch = originalFetch;
    }

    const legacyFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/embed')) return responseJson({}, 404);
      if (url.endsWith('/api/embeddings')) return responseJson({ embedding: [4, 5] });
      return responseJson({}, 503);
    }) as typeof fetch;
    try {
      const provider = new OllamaProvider(
        {
          baseUrl: 'http://ollama.local',
          model: 'model',
          embeddingModel: 'embed',
        },
        5_000,
      );
      await expect(provider.embed('legacy')).resolves.toEqual([4, 5]);
      await expect(provider.health()).resolves.toMatchObject({
        available: false,
        detail: 'HTTP 503',
      });
    } finally {
      globalThis.fetch = legacyFetch;
    }
  });

  it('uses OpenAI-compatible local chat, tools, embeddings, and model health for v1 bases', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/chat/completions')) {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return responseJson({
          choices: [
            {
              message: {
                content: 'Local answer',
                tool_calls: [
                  {
                    id: 'openai-call-1',
                    type: 'function',
                    function: { name: 'workspace_list', arguments: '{"path":"."}' },
                  },
                ],
              },
            },
          ],
        });
      }
      if (url.endsWith('/embeddings')) return responseJson({ data: [{ embedding: [6, 7, 8] }] });
      if (url.endsWith('/models')) return responseJson({ data: [{ id: 'local-model' }] });
      return responseJson({}, 404);
    }) as typeof fetch;
    try {
      const provider = new OllamaProvider(
        {
          baseUrl: 'http://llama.local/v1/',
          model: 'local-model',
          embeddingModel: 'local-embed',
          embeddingBaseUrl: 'http://embed.local/v1/',
        },
        5_000,
      );
      const events: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: '',
        messages: [
          { role: 'system', content: 'Follow verified policy' },
          { role: 'user', content: 'inspect files' },
        ],
        systemPrompt: 'Follow verified policy',
        tools: [
          {
            name: 'workspace.list',
            description: 'List files',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }))
        events.push(event);
      expect(events).toEqual([
        { type: 'delta', text: 'Local answer' },
        {
          type: 'tool_call',
          id: 'openai-call-1',
          name: 'workspace.list',
          arguments: { path: '.' },
        },
        { type: 'done', text: 'Local answer' },
      ]);
      expect(requestBody).toEqual({
        model: 'local-model',
        messages: [
          { role: 'system', content: 'Follow verified policy' },
          { role: 'user', content: 'inspect files' },
        ],
        stream: false,
        tools: [
          {
            type: 'function',
            function: {
              name: 'workspace_list',
              description: 'List files',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      });
      expect(await provider.embed('hi')).toEqual([6, 7, 8]);
      expect(await provider.health()).toMatchObject({ available: true, models: ['local-model'] });
      expect(calls).toEqual(
        expect.arrayContaining([
          'http://llama.local/v1/chat/completions',
          'http://embed.local/v1/embeddings',
          'http://llama.local/v1/models',
        ]),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('converts a sole fenced JSON request for an advertised tool into a tool call', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      responseJson({
        choices: [
          {
            message: {
              content: '```json\n{\n  "tool": "workspace.list",\n  "arguments": {}\n}\n```',
            },
          },
        ],
      })) as typeof fetch;
    try {
      const provider = new OllamaProvider(
        {
          baseUrl: 'http://llama.local/v1',
          model: 'local-model',
          embeddingModel: 'local-embed',
        },
        5_000,
      );
      const events: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: '',
        messages: [{ role: 'user', content: 'Try something' }],
        tools: [
          {
            name: 'workspace.list',
            description: 'List files',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }))
        events.push(event);

      expect(events).toEqual([
        {
          type: 'tool_call',
          id: expect.any(String),
          name: 'workspace.list',
          arguments: {},
        },
        { type: 'done', text: '' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps prose containing tool-call JSON as assistant text', async () => {
    const originalFetch = globalThis.fetch;
    const content =
      'For example:\n```json\n{"tool":"workspace.list","arguments":{}}\n```\nUse that shape.';
    globalThis.fetch = (async () =>
      responseJson({ choices: [{ message: { content } }] })) as typeof fetch;
    try {
      const provider = new OllamaProvider(
        {
          baseUrl: 'http://llama.local/v1',
          model: 'local-model',
          embeddingModel: 'local-embed',
        },
        5_000,
      );
      const events: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: '',
        messages: [{ role: 'user', content: 'Show an example' }],
        tools: [
          {
            name: 'workspace.list',
            description: 'List files',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }))
        events.push(event);

      expect(events).toEqual([
        { type: 'delta', text: content },
        { type: 'done', text: content },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('serializes Ollama tools using the official shape and aggregates streamed tool calls', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseStream([
        JSON.stringify({
          message: {
            tool_calls: [
              {
                id: 'call-1',
                function: { index: 0, name: 'workspace.list', arguments: {} },
              },
            ],
          },
        }),
        JSON.stringify({ message: { content: '' }, done: true }),
      ]);
    }) as typeof fetch;
    try {
      const provider = new OllamaProvider(
        { baseUrl: 'http://ollama.local', model: 'chat-model', embeddingModel: 'embed-model' },
        5_000,
      );
      const events: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: 'chat-model',
        messages: [{ role: 'user', content: 'list files' }],
        tools: [
          {
            name: 'workspace.list',
            description: 'List files',
            parameters: { type: 'object', properties: {} },
          },
        ],
        reasoning: false,
      }))
        events.push(event);
      expect(requestBody?.options).toEqual({ num_ctx: 262_144 });
      expect(requestBody?.think).toBe(false);
      expect(requestBody?.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'workspace.list',
            description: 'List files',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]);
      expect(events).toEqual([
        { type: 'tool_call', id: 'call-1', name: 'workspace.list', arguments: {} },
        { type: 'done', text: '' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('serializes image content using Ollama native vision payloads', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseStream([
        JSON.stringify({ message: { content: 'image inspected' }, done: true }),
      ]);
    }) as typeof fetch;
    try {
      const provider = new OllamaProvider(
        { baseUrl: 'http://ollama.local', model: 'vision-model', embeddingModel: 'embed-model' },
        5_000,
      );
      for await (const _event of provider.stream({
        model: 'vision-model',
        messages: [
          {
            role: 'user',
            content: 'What is in this image?',
            images: [{ name: 'photo.png', mimeType: 'image/png', data: 'aGVsbG8=' }],
          },
        ],
      })) {
        // Drain the provider stream so the request completes.
      }
      expect(requestBody?.messages).toEqual([
        {
          role: 'user',
          content: 'What is in this image?',
          images: ['aGVsbG8='],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns the final Codex message even when the CLI hangs during teardown', async () => {
    const root = await makeRoot();
    const executable = join(root, 'codex-hanging-fake.mjs');
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-fake 1\\n');
  process.exit(0);
}
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(2);
writeFileSync(args[outputIndex + 1], 'hello world');
setInterval(() => {}, 1_000);
`,
    );
    await chmod(executable, 0o755);
    const provider = new CodexProvider({
      executable,
      model: 'model',
      workspaceRoot: root,
      timeoutMs: 2_000,
    });
    const events: ProviderStreamEvent[] = [];

    for await (const event of provider.stream({
      model: 'model',
      messages: [{ role: 'user', content: 'hello' }],
    }))
      events.push(event);

    expect(events).toEqual([
      { type: 'delta', text: 'hello world' },
      { type: 'done', text: 'hello world' },
    ]);
  });

  it('executes Codex through a real subprocess boundary', async () => {
    const root = await makeRoot();
    const executable = join(root, 'codex-fake.mjs');
    const argsPath = join(root, 'codex-args.json');
    const stdinPath = join(root, 'codex-stdin.txt');
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
if (process.argv.includes('--version')) process.stdout.write('codex-fake 1\\n');
else {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  writeFileSync(${JSON.stringify(stdinPath)}, input);
  process.stdout.write(JSON.stringify({ item: { type: 'error', message: 'non-fatal warning' } }) + '\\n' + JSON.stringify({ item: { text: 'hello' } }) + '\\n' + JSON.stringify({ item: { text: 'hello world' } }) + '\\n');
}
`,
    );
    await chmod(executable, 0o755);
    const provider = new CodexProvider({
      executable,
      model: 'model',
      workspaceRoot: root,
      timeoutMs: 5_000,
    });
    const events: ProviderStreamEvent[] = [];
    for await (const event of provider.stream({
      model: 'model',
      messages: [
        { role: 'system', content: 'private runtime catalog' },
        { role: 'user', content: 'hello' },
      ],
      systemPrompt: 'private runtime catalog',
    }))
      events.push(event);
    expect(events).toEqual([
      { type: 'delta', text: 'hello world' },
      { type: 'done', text: 'hello world' },
    ]);
    const explicitArgs = JSON.parse(await readFile(argsPath, 'utf8')) as string[];
    expect(explicitArgs).not.toContain('--json');
    expect(explicitArgs).not.toContain('--ephemeral');
    expect(explicitArgs).toContain('--output-last-message');
    expect(explicitArgs).toContain('--ask-for-approval');
    expect(explicitArgs).toContain('never');
    expect(explicitArgs.indexOf('--ask-for-approval')).toBeLessThan(explicitArgs.indexOf('exec'));
    expect(explicitArgs).toContain('--model');
    expect(explicitArgs).toContain('model');
    expect(explicitArgs.join(' ')).not.toContain('private runtime catalog');
    expect(explicitArgs.join(' ')).not.toContain('hello');
    expect(await readFile(stdinPath, 'utf8')).toBe(
      '[system]\nprivate runtime catalog\n\n[user]\nhello',
    );
    const defaultProvider = new CodexProvider({
      executable,
      model: '',
      workspaceRoot: root,
      timeoutMs: 5_000,
    });
    for await (const _event of defaultProvider.stream({
      model: '',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      // Drain the real subprocess stream.
    }
    const defaultArgs = JSON.parse(await readFile(argsPath, 'utf8')) as string[];
    expect(defaultArgs).not.toContain('--model');

    expect(await provider.health()).toMatchObject({ available: true, detail: 'codex-fake 1' });
    await expect(provider.embed()).rejects.toThrow('does not provide embeddings');
  });

  it('creates, triggers, pauses, resumes, and validates schedules', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const events: string[] = [];
    const runs: string[] = [];
    const scheduler = new Scheduler(
      store,
      (type) => events.push(type),
      async (schedule) => {
        runs.push(schedule.name);
      },
    );
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(nextCronRun('* * * * *', now)).toBe(now + 60_000);
    expect(nextCronRun('*/5 * * * *', now)).toBe(now + 5 * 60_000);
    expect(() => nextCronRun('* * * *', now)).toThrow('five fields');
    const manual = scheduler.create(
      { name: 'manual', type: 'manual', expression: '', agentInput: 'run' },
      now,
    );
    const once = scheduler.create(
      { name: 'once', type: 'once', expression: String(now + 1), agentInput: 'once' },
      now,
    );
    scheduler.create(
      { name: 'disabled', type: 'interval', expression: '1s', agentInput: 'off', enabled: false },
      now,
    );
    const interval = scheduler.create(
      { name: 'interval', type: 'interval', expression: '2m', agentInput: 'interval' },
      now,
    );
    expect(interval.nextRunAt).toBe(now + 120_000);
    const startup = scheduler.create(
      { name: 'startup', type: 'startup', expression: '', agentInput: 'startup' },
      now,
    );
    expect(startup.nextRunAt).toBe(now);
    expect(() =>
      scheduler.create({ name: 'bad', type: 'once', expression: 'nope', agentInput: 'x' }, now),
    ).toThrow('One-shot expression must be an epoch timestamp');
    expect(() =>
      scheduler.create({ name: 'bad', type: 'interval', expression: 'nope', agentInput: 'x' }, now),
    ).toThrow('Invalid interval expression');
    expect(scheduler.list()).toHaveLength(5);
    await scheduler.trigger(manual.id);
    await scheduler.trigger(once.id);
    expect(runs).toEqual(['manual', 'once']);
    expect(store.listTasks()).toHaveLength(2);
    expect(store.listTasks().every((task) => task.status === 'completed')).toBe(true);
    scheduler.pause(manual.id);
    expect(scheduler.list().find((entry) => entry.id === manual.id)?.enabled).toBe(false);
    expect(
      scheduler.update(manual.id, { name: 'updated manual', agentInput: 'updated' }),
    ).toMatchObject({
      name: 'updated manual',
      agentInput: 'updated',
    });
    scheduler.resume(manual.id, now);
    expect(scheduler.list().find((entry) => entry.id === manual.id)?.enabled).toBe(true);
    scheduler.start();
    scheduler.start();
    scheduler.stop();
    expect(events).toEqual(
      expect.arrayContaining([
        'schedule.created',
        'schedule.triggered',
        'schedule.paused',
        'schedule.updated',
      ]),
    );
    expect(() =>
      scheduler.create({ name: '', type: 'manual', expression: '', agentInput: 'x' }),
    ).toThrow('Schedule name and agent input are required');
    expect(() => scheduler.update(manual.id, { name: '', agentInput: 'x' })).toThrow(
      'Schedule name and agent input are required',
    );
    await expect(scheduler.trigger('missing')).rejects.toThrow('Unknown schedule');
    expect(() => scheduler.resume('missing')).toThrow('Unknown schedule');
    const recoveryRoot = await makeRoot();
    const recoveryStore = makeStore(recoveryRoot);
    const recoveryScheduler = new Scheduler(
      recoveryStore,
      () => undefined,
      async () => undefined,
    );
    const recoverySchedule = recoveryScheduler.create({
      name: 'recovery',
      type: 'manual',
      expression: '',
      agentInput: 'recover me',
    });
    const interrupted = recoveryStore.createTask(
      'schedule.run',
      { name: recoverySchedule.name },
      recoverySchedule.id,
    );
    recoveryStore.updateTask(interrupted.id, 'running');
    recoveryScheduler.start();
    recoveryScheduler.stop();
    expect(recoveryStore.listTasks().find((task) => task.id === interrupted.id)).toMatchObject({
      status: 'failed',
      payload: { error: 'Task interrupted by daemon restart' },
    });
    let providerCancelTask: string | undefined;
    const cancellable = new Scheduler(
      store,
      (type) => events.push(type),
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      (taskId) => {
        providerCancelTask = taskId;
      },
    );
    let finish!: () => void;
    const cancellableSchedule = cancellable.create({
      name: 'cancellable',
      type: 'manual',
      expression: '',
      agentInput: 'cancel me',
    });
    const pending = cancellable.trigger(cancellableSchedule.id);
    const activeTask = store
      .listTasks()
      .find((task) => task.scheduleId === cancellableSchedule.id && task.status === 'running');
    expect(activeTask).toBeDefined();
    cancellable.cancelTask(activeTask?.id ?? '');
    expect(providerCancelTask).toBe(activeTask?.id);
    finish();
    await pending;
    expect(store.listTasks().find((task) => task.id === activeTask?.id)).toMatchObject({
      status: 'cancelled',
      payload: { error: 'Task cancelled' },
    });
    expect(events).toContain('task.cancelled');
    expect(() => cancellable.cancelTask(activeTask?.id ?? '')).toThrow();
    let attempts = 0;
    const retryScheduler = new Scheduler(
      store,
      (type) => events.push(type),
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary failure');
      },
    );
    const retryInput = {
      name: 'retrying',
      type: 'manual',
      expression: '',
      agentInput: 'retry me',
      policy: { maxAttempts: 2, retryDelayMs: 0 },
    } as Parameters<Scheduler['create']>[0];
    const retrySchedule = retryScheduler.create(retryInput);
    await retryScheduler.trigger(retrySchedule.id);
    expect(attempts).toBe(2);
    expect(store.listTasks().find((task) => task.scheduleId === retrySchedule.id)).toMatchObject({
      status: 'completed',
      payload: { attempts: 2 },
    });
    const parallelReleases: Array<() => void> = [];
    let parallelRuns = 0;
    const parallelScheduler = new Scheduler(
      store,
      (type) => events.push(type),
      async () => {
        parallelRuns += 1;
        await new Promise<void>((resolve) => {
          parallelReleases.push(resolve);
        });
      },
    );
    const parallelSchedule = parallelScheduler.create({
      name: 'parallel',
      type: 'manual',
      expression: '',
      agentInput: 'run in parallel',
      policy: { concurrencyLimit: 2 },
    });
    const parallelOne = parallelScheduler.trigger(parallelSchedule.id);
    const parallelTwo = parallelScheduler.trigger(parallelSchedule.id);
    expect(parallelRuns).toBe(2);
    for (const release of parallelReleases) release();
    await Promise.all([parallelOne, parallelTwo]);
    expect(
      store.listTasks().filter((task) => task.scheduleId === parallelSchedule.id),
    ).toHaveLength(2);
    let skippedRuns = 0;
    const skipScheduler = new Scheduler(
      store,
      (type) => events.push(type),
      async () => {
        skippedRuns += 1;
      },
    );
    const missedSchedule = skipScheduler.create({
      name: 'missed',
      type: 'once',
      expression: String(Date.now() - 1_000),
      agentInput: 'skip stale run',
      policy: { missedRun: 'skip' },
    });
    skipScheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    skipScheduler.stop();
    expect(skippedRuns).toBe(0);
    expect(
      skipScheduler.list().find((schedule) => schedule.id === missedSchedule.id),
    ).toMatchObject({
      enabled: false,
      nextRunAt: null,
      policy: { missedRun: 'skip' },
    });
    const failing = new Scheduler(
      store,
      (type) => events.push(type),
      async () => {
        throw new Error('background failed');
      },
    );
    const failingSchedule = failing.create(
      { name: 'failing', type: 'manual', expression: '', agentInput: 'fail' },
      now,
    );
    await failing.trigger(failingSchedule.id);
    expect(store.listTasks().find((task) => task.scheduleId === failingSchedule.id)).toMatchObject({
      status: 'failed',
      payload: { error: 'background failed' },
    });
    const falseSuccess = new Scheduler(
      store,
      (type) => events.push(type),
      async () => ({ status: 'failed', output: 'provider failed' }),
    );
    const falseSuccessSchedule = falseSuccess.create({
      name: 'failed run result',
      type: 'manual',
      expression: '',
      agentInput: 'report real terminal state',
    });
    await falseSuccess.trigger(falseSuccessSchedule.id);
    expect(
      store.listTasks().find((task) => task.scheduleId === falseSuccessSchedule.id),
    ).toMatchObject({
      status: 'failed',
      payload: { error: 'Agent run ended with status: failed' },
    });
  });

  it('exposes durable memory and background-task operations as model-facing tools', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = new DeterministicProvider();
    const providers = providerMap({ ollama: provider });
    let release!: () => void;
    const scheduler = new Scheduler(
      store,
      () => undefined,
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const tools = new ToolRegistry(root, undefined, {}, { store, scheduler, providers });
    const context = { root, permissions: permissive };
    const stored = (await tools.execute(
      'memory.store',
      { content: 'Tyler prefers local-first software', metadata: { token: 'private' } },
      context,
    )) as { id: string; stored: boolean; hasEmbedding: boolean };
    expect(stored).toMatchObject({ stored: true, hasEmbedding: true });
    expect(
      await tools.execute('memory.search', { query: 'local-first software' }, context),
    ).toMatchObject({ mode: 'semantic', results: [expect.objectContaining({ id: stored.id })] });
    expect(await tools.execute('memory.forget', { id: stored.id }, context)).toEqual({
      id: stored.id,
      deleted: true,
    });
    const schedule = (await tools.execute(
      'schedule.create',
      { name: 'manual schedule', type: 'manual', expression: '', agentInput: 'run it' },
      context,
    )) as { id: string };
    expect(await tools.execute('schedule.list', {}, context)).toMatchObject({
      schedules: [expect.objectContaining({ id: schedule.id })],
    });
    const task = (await tools.execute(
      'task.create',
      { name: 'long task', agentInput: 'background work' },
      context,
    )) as { id: string; status: string };
    expect(task.status).toBe('queued');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await tools.execute('task.cancel', { id: task.id }, context)).toEqual({
      ok: true,
      id: task.id,
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.listTasks().find((entry) => entry.id === task.id)).toMatchObject({
      status: 'cancelled',
    });
  });
});

describe('agent runtime orchestration', () => {
  function makeAgentProvider(
    name: string,
    behavior: (request: ProviderRequest) => AsyncIterable<ProviderStreamEvent>,
    embed: (text: string) => Promise<number[]> = async () =>
      Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
  ): ProviderAdapter {
    return {
      name,
      model: 'agent-model',
      stream: behavior,
      embed,
      health: async (): Promise<ProviderHealth> => ({ name, available: true, detail: 'test' }),
    };
  }

  it('runs a deterministic stream, stores memory, and persists events/messages', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = new DeterministicProvider();
    const providers = providerMap({ deterministic: provider, ollama: provider });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers,
      tools: new ToolRegistry(root),
    });
    const events: string[] = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event.type));
    const created = runtime.createSession('Runtime test');
    expect(runtime.listSessions()).toHaveLength(1);
    expect(runtime.getSession(created.session.id)).toMatchObject({ id: created.session.id });
    expect(runtime.listThreads(created.session.id)).toHaveLength(1);
    expect(runtime.createThread(created.session.id, 'Second thread')).toMatchObject({
      title: 'Second thread',
    });
    expect(await runtime.providerHealth()).toHaveLength(2);
    runtime.publishEvent('provider.unavailable', { provider: 'test' });
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'hello',
      provider: 'deterministic',
    });
    const completed = await runtime.waitForRun(run.id);
    expect(completed).toMatchObject({
      status: 'completed',
      output: 'NUAAI deterministic test response',
    });
    const runMessages = runtime.listMessages(created.thread.id);
    expect(runMessages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(
      runMessages.map((message) =>
        store.listMessageArtifacts(message.id).find((artifact) => artifact.kind === 'run_link'),
      ),
    ).toEqual([
      expect.objectContaining({ payload: { runId: run.id } }),
      expect.objectContaining({ payload: { runId: run.id } }),
    ]);
    expect(store.searchMemoryRows()).toHaveLength(0);
    expect(events).toEqual(
      expect.arrayContaining([
        'session.created',
        'thread.created',
        'run.created',
        'run.started',
        'model.started',
        'model.delta',
        'model.completed',
        'run.completed',
      ]),
    );
    expect(events).not.toContain('memory.stored');
    expect(runtime.capabilities().permissions).toEqual(['read']);
    expect(runtime.capabilities().tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['workspace.write', 'workspace.command']),
    );
    expect(runtime.status().activeRuns).toBe(0);
    await expect(runtime.waitForRun('missing')).rejects.toThrow('Unknown run');
    expect(() => runtime.startRun({ threadId: created.thread.id, input: ' ' })).toThrow(
      'Run input is required',
    );
    expect(() => runtime.startRun({ threadId: 'missing', input: 'x' })).toThrow('Unknown thread');
    expect(() => runtime.cancelRun('missing')).toThrow('Unknown run');
    expect(() => runtime.resumeRun('missing')).toThrow('Unknown run');
    expect(() => runtime.resumeRun(run.id)).toThrow('is not resumable');
    const limitedRuntime = new AgentRuntime({
      root,
      config: {
        ...defaultRuntimeConfig(root),
        limits: { ...defaultRuntimeConfig(root).limits, maxOutputBytes: 1 },
      },
      store,
      providers,
      tools: new ToolRegistry(root),
    });
    const limitedSession = limitedRuntime.createSession('Output limit');
    const limitedRun = limitedRuntime.startRun({
      threadId: limitedSession.thread.id,
      input: 'too much',
      provider: 'deterministic',
    });
    await expect(limitedRuntime.waitForRun(limitedRun.id)).resolves.toMatchObject({
      status: 'failed',
    });
    unsubscribe();
  });

  it('projects provider-owned tool events without re-executing them in NUAAI', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let registryExecutions = 0;
    const provider: ProviderAdapter = {
      ...makeAgentProvider('codex', async function* () {
        yield {
          type: 'tool_started',
          id: 'codex-tool-1',
          name: 'codex.shell',
          arguments: { command: 'pwd' },
        };
        yield {
          type: 'tool_completed',
          id: 'codex-tool-1',
          name: 'codex.shell',
          arguments: { command: 'pwd' },
          result: '/workspace',
          isError: false,
        };
        yield { type: 'delta', text: 'Codex completed the command.' };
        yield { type: 'done', text: '' };
      }),
      ownsToolLoop: true,
    };
    const tools = new ToolRegistry(root);
    const originalExecute = tools.execute.bind(tools);
    tools.execute = (async (...args) => {
      registryExecutions += 1;
      return originalExecute(...args);
    }) as typeof tools.execute;
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ codex: provider, ollama: provider }),
      tools,
    });
    const created = runtime.createSession('Codex provider-owned loop');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Run pwd and report the result.',
      provider: 'codex',
      permissions: permissive,
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Codex completed the command.',
    });
    expect(registryExecutions).toBe(0);
    expect(
      store
        .listEvents()
        .filter((event) => event.runId === run.id)
        .map((event) => event.type),
    ).toEqual(expect.arrayContaining(['tool.started', 'tool.completed', 'run.completed']));
  });

  it('requests finalization when a provider-owned loop returns a polite promise only', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let requests = 0;
    const provider: ProviderAdapter = {
      ...makeAgentProvider('codex', async function* () {
        requests += 1;
        yield {
          type: 'done',
          text:
            requests === 1
              ? "Sure, I'll check the remaining files next."
              : 'Provider-owned final answer from completed work.',
        };
      }),
      ownsToolLoop: true,
    };
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ codex: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Provider-owned finalization');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Inspect and report.',
      provider: 'codex',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Provider-owned final answer from completed work.',
    });
    expect(requests).toBe(2);
  });

  it('fails a provider-owned loop that repeats a promise after correction', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let requests = 0;
    const promise = "Sure, I'll check the remaining files next.";
    const provider: ProviderAdapter = {
      ...makeAgentProvider('codex', async function* () {
        requests += 1;
        yield { type: 'done', text: promise };
      }),
      ownsToolLoop: true,
    };
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ codex: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Repeated provider-owned promise');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Inspect and report.',
      provider: 'codex',
      permissions: permissive,
    });

    const completed = await runtime.waitForRun(run.id);
    expect(completed.status).toBe('failed');
    expect(completed.output).not.toBe(promise);
    expect(requests).toBe(2);
  });

  it('fails provider-owned runs when an action reports an error', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider: ProviderAdapter = {
      ...makeAgentProvider('codex', async function* () {
        yield { type: 'tool_started', id: 'failed-action', name: 'codex.shell', arguments: {} };
        yield {
          type: 'tool_completed',
          id: 'failed-action',
          name: 'codex.shell',
          arguments: {},
          result: 'command failed',
          isError: true,
        };
        yield { type: 'done', text: 'Everything worked.' };
      }),
      ownsToolLoop: true,
    };
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ codex: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Provider failure truth');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Run the action.',
      provider: 'codex',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('action failed'),
    });
  });

  it('serializes runs in one thread and prevents provider overlap', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const order: string[] = [];
    const contexts = new Map<string, Array<{ role: string; content: string }>>();
    let active = 0;
    let maximumActive = 0;
    const provider = makeAgentProvider('queued', async function* (request) {
      const input = request.messages.at(-1)?.content ?? '';
      contexts.set(
        input,
        request.messages.map(({ role, content }) => ({ role, content })),
      );
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`start:${request.messages.at(-1)?.content}`);
      await new Promise((resolve) =>
        setTimeout(resolve, request.messages.at(-1)?.content === 'one' ? 30 : 0),
      );
      order.push(`end:${request.messages.at(-1)?.content}`);
      active -= 1;
      yield { type: 'done', text: `done:${request.messages.at(-1)?.content}` };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ queued: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Queued runs');
    const first = runtime.startRun({
      threadId: created.thread.id,
      input: 'one',
      provider: 'queued',
    });
    const second = runtime.startRun({
      threadId: created.thread.id,
      input: 'two',
      provider: 'queued',
    });

    await expect(
      Promise.all([runtime.waitForRun(first.id), runtime.waitForRun(second.id)]),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'completed', output: 'done:one' }),
      expect.objectContaining({ status: 'completed', output: 'done:two' }),
    ]);
    expect(maximumActive).toBe(1);
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
    expect(contexts.get('one')).not.toContainEqual({ role: 'user', content: 'two' });
    expect(contexts.get('two')).toContainEqual({ role: 'assistant', content: 'done:one' });
    expect(
      store
        .listEvents()
        .filter((event) => event.type === 'run.queued')
        .map((event) => event.runId),
    ).toEqual([first.id, second.id]);
  });

  it('reuses an existing source run for the same idempotency key', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let providerCalls = 0;
    const provider = makeAgentProvider('idempotent', async function* () {
      providerCalls += 1;
      yield { type: 'done', text: 'once' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ idempotent: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Idempotent source');

    const first = runtime.startRun({
      threadId: created.thread.id,
      input: 'handle once',
      provider: 'idempotent',
      idempotencyKey: 'matrix:$event',
    });
    const duplicate = runtime.startRun({
      threadId: created.thread.id,
      input: 'handle once',
      provider: 'idempotent',
      idempotencyKey: 'matrix:$event',
    });

    expect(duplicate.id).toBe(first.id);
    await expect(runtime.waitForRun(first.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'once',
    });
    expect(providerCalls).toBe(1);
  });

  it('marks interrupted runs failed instead of replaying them after restart', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const created = store.createSession('Interrupted run');
    const interrupted = store.createRun(
      created.thread.id,
      'do not repeat this action',
      'restart-test',
      'agent-model',
      'interrupted-correlation',
    );
    store.updateRun(interrupted.id, { status: 'running' });
    let providerCalls = 0;
    const provider = makeAgentProvider('restart-test', async function* () {
      providerCalls += 1;
      yield { type: 'done', text: 'replayed' };
    });

    new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'restart-test': provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(providerCalls).toBe(0);
    expect(store.getRun(interrupted.id)).toMatchObject({
      status: 'failed',
      output: expect.stringContaining('interrupted by daemon restart'),
    });
  });

  it('marks a run timeout as failed with an explicit timeout reason', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = makeAgentProvider('slow', async function* (request) {
      const signal = request.signal;
      if (!signal) throw new Error('Expected a run cancellation signal');
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      yield { type: 'done', text: 'unreachable' };
    });
    const config = defaultRuntimeConfig(root);
    config.limits.runTimeoutMs = 10;
    const runtime = new AgentRuntime({
      root,
      config,
      store,
      providers: providerMap({ slow: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Timeout truth');
    const run = runtime.startRun({ threadId: created.thread.id, input: 'wait', provider: 'slow' });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('timed out'),
    });
  });

  it('persists a fenced writer claim and refuses a competing owner', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const created = store.createSession('Writer claim');
    const first = store.createRun(created.thread.id, 'one', 'test', 'model', 'corr-1');
    const second = store.createRun(created.thread.id, 'two', 'test', 'model', 'corr-2');

    expect(store.claimRunWriter(created.thread.id, first.id, 'owner-a')).toBe(true);
    expect(store.claimRunWriter(created.thread.id, second.id, 'owner-b')).toBe(false);
    store.releaseRunWriter(created.thread.id, first.id, 'owner-a');
    expect(store.claimRunWriter(created.thread.id, second.id, 'owner-b')).toBe(true);
    store.releaseRunWriter(created.thread.id, second.id, 'owner-b');
  });

  it('compacts older transcript state while keeping recent messages and summary versioning', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const created = store.createSession('Compaction');
    for (let index = 0; index < 6; index += 1)
      store.addMessage(created.thread.id, index % 2 ? 'assistant' : 'user', `message-${index}`);

    const summary = store.compactThread(created.thread.id, 2, 500);
    expect(summary).toMatchObject({ threadId: created.thread.id, messageCount: 4, version: 1 });
    const context = store.listContextMessages(created.thread.id, 2);
    expect(context[0]).toMatchObject({ role: 'system' });
    expect(context[0]?.content).toContain('message-0');
    expect(context.map((message) => message.content)).toEqual(
      expect.arrayContaining(['message-4', 'message-5']),
    );
    expect(context.map((message) => message.content)).not.toContain('message-1');
  });

  it('exposes the same live capability manifest to provider-owned loops and prompts', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requests: ProviderRequest[] = [];
    const provider = {
      ...makeAgentProvider('codex', async function* (request) {
        requests.push(request);
        yield { type: 'done', text: 'capabilities received' };
      }),
      ownsToolLoop: true,
    };
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ codex: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Capability manifest');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Tell me what you can do.',
      provider: 'codex',
      permissions: permissive,
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'capabilities received',
    });
    const dynamicNames =
      requests[0]?.dynamicTools?.map((tool) => `${tool.namespace}.${tool.name}`) ?? [];
    expect(dynamicNames).toEqual(
      expect.arrayContaining(['nuaai.workspace_read', 'nuaai.workspace_write']),
    );
    expect(requests[0]?.systemPrompt).toContain('Live capability manifest');
    expect(requests[0]?.systemPrompt).toContain('nuaai.workspace_write');
    expect(store.listEvents().map((event) => event.type)).toEqual(
      expect.arrayContaining(['capabilities.assembled', 'prompt.assembled']),
    );
    expect(
      store.listEvents().find((event) => event.type === 'capabilities.assembled')?.payload.tools,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'workspace.write',
          governance: expect.objectContaining({ sideEffects: 'workspace', approval: 'profile' }),
        }),
      ]),
    );
  });

  it('keeps discovered MCP tools behind the registry discovery boundary', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requests = new Map<string, ProviderRequest>();
    const provider = (name: string, ownsToolLoop: boolean): ProviderAdapter => ({
      ...makeAgentProvider(name, async function* (request) {
        requests.set(name, request);
        yield { type: 'done', text: 'registry catalog received' };
      }),
      ownsToolLoop,
    });
    const direct = provider('registry-direct', false);
    const owned = provider('registry-owned', true);
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const mcp = {
      schemas: () => [
        {
          name: 'mcp.remote.expensive',
          description: 'An individually discovered MCP tool',
          parameters: { type: 'object' },
        },
      ],
      status: () => ({ servers: ['remote'], failures: {}, tools: [] }),
      discover: async () => [{ name: 'mcp.remote.expensive' }],
      executeComputer: async () => ({ ok: true }),
      execute: async () => ({ ok: true }),
    };
    const tools = new ToolRegistry(root, undefined, {}, { mcp } as never);
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'registry-direct': direct, 'registry-owned': owned, ollama }),
      tools,
      mcp: mcp as never,
    });

    for (const providerName of ['registry-direct', 'registry-owned']) {
      const created = runtime.createSession(providerName);
      const run = runtime.startRun({
        threadId: created.thread.id,
        input: 'Tell me what tools are available.',
        provider: providerName,
        permissions: permissive,
      });
      await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({ status: 'completed' });
    }

    const directNames = requests.get('registry-direct')?.tools?.map((tool) => tool.name) ?? [];
    expect(directNames).toEqual(expect.arrayContaining(['mcp.discover', 'mcp.execute']));
    expect(directNames).not.toContain('mcp.remote.expensive');
    const dynamicNames =
      requests
        .get('registry-owned')
        ?.dynamicTools?.map((tool) => `${tool.namespace}.${tool.name}`) ?? [];
    expect(dynamicNames).toEqual(
      expect.arrayContaining(['nuaai.mcp_discover', 'nuaai.mcp_execute']),
    );
    expect(dynamicNames).not.toContain('nuaai.mcp_remote_expensive');
  });

  it('rejects an action claim when the model emits no tool call', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = makeAgentProvider('hallucinating-action', async function* () {
      yield { type: 'done', text: 'I found 20 repositories in your GitHub account.' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'hallucinating-action': provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Verified action contract');
    const input = 'List all repositories via the GitHub CLI.';
    expect(requestRequiresVerifiedTool(input)).toBe(true);
    const run = runtime.startRun({
      threadId: created.thread.id,
      input,
      provider: 'hallucinating-action',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output:
        'NUAAI did not verify this request because no tool was executed. I will not report model-generated claims as facts.',
    });
    expect(store.listMessages(created.thread.id).at(-1)?.content).toContain('did not verify');
  });

  it('does not require external evidence for capability questions', () => {
    expect(requestRequiresVerifiedTool('What tools and browser access do you have?')).toBe(false);
    expect(requestRequiresVerifiedTool('Tell me a joke about browsers')).toBe(false);
    expect(requestRequiresVerifiedTool('Stress test yourself. Do not use tools.')).toBe(false);
    expect(
      requestRequiresVerifiedTool("What's the latest info on the UFC 330 fight tonight?"),
    ).toBe(true);
  });

  it('keeps the allowed tool catalog stable for an ambiguous stress request', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requests: ProviderRequest[] = [];
    const provider = makeAgentProvider('ambiguous-tools', async function* (request) {
      requests.push(request);
      yield { type: 'done', text: 'Specify a capability to test.' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'ambiguous-tools': provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Ambiguous tools');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Stress test yourself.',
      provider: 'ambiguous-tools',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Specify a capability to test.',
    });
    expect(requests[0]?.tools?.length).toBeGreaterThan(0);
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['workspace.read', 'workspace.write', 'github.repo.list']),
    );
    expect(requests[0]?.reasoning).toBe(true);
  });

  it('selects web tools for current-information requests', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requests: ProviderRequest[] = [];
    const provider = makeAgentProvider('current-info', async function* (request) {
      requests.push(request);
      yield { type: 'done', text: 'No verified result.' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'current-info': provider, ollama: provider }),
      tools: new ToolRegistry(root, new SearchStack({ browser: null })),
    });
    const created = runtime.createSession('Current information');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: "What's the latest info on the UFC 330 fight tonight?",
      provider: 'current-info',
      permissions: {
        ...permissive,
        capabilities: { ...permissive.capabilities, network: true },
      },
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output:
        'NUAAI did not verify this request because no tool was executed. I will not report model-generated claims as facts.',
    });
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['web.search', 'web.fetch']),
    );
  });
  it('rejects an unverified no-tool claim with a truthful capability failure', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = makeAgentProvider('missing-tool-claim', async function* () {
      yield {
        type: 'done',
        text: 'There is no github.repo.list tool registered, so I will run it later.',
      };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'missing-tool-claim': provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Missing tool claim');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'List my GitHub repositories.',
      provider: 'missing-tool-claim',
      permissions: permissive,
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('rejected an unverified capability claim'),
    });
  });

  it('does not reject capability language in ordinary conversation', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = makeAgentProvider('ordinary-capability-language', async function* () {
      yield {
        type: 'done',
        text: "I don't have visibility into the queue or message system from this conversational reply.",
      };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'ordinary-capability-language': provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Ordinary conversation');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Are you just making stuff up?',
      provider: 'ordinary-capability-language',
      permissions: permissive,
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output:
        "I don't have visibility into the queue or message system from this conversational reply.",
    });
  });

  it('sends the complete permission-filtered tool catalog to the provider', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requests: ProviderRequest[] = [];
    const provider = makeAgentProvider('tool-selection', async function* (request) {
      requests.push(request);
      yield { type: 'done', text: 'I did not run a tool.' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'tool-selection': provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Tool selection');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'List my GitHub repositories.',
      provider: 'tool-selection',
      permissions: permissive,
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({ status: 'failed' });
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      'github.auth',
      'github.repo.list',
      'workspace.command',
      'workspace.inspect',
      'workspace.list',
      'workspace.read',
      'workspace.search',
      'workspace.write',
    ]);
  });

  it('rejects repeated model calls to tools outside the permission-filtered catalog', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const execute = vi.fn(async () => ({ ok: true }));
    let requests = 0;
    const provider = makeAgentProvider('tool-boundary', async function* () {
      requests += 1;
      yield {
        type: 'tool_call',
        id: `out-of-scope-${requests}`,
        name: 'provider.switch',
        arguments: { provider: 'codex', model: 'gpt-test' },
      };
    });
    const tools = {
      schemas: () => [
        {
          name: 'memory.forget',
          description: 'Forget persisted memory',
          parameters: { type: 'object' },
        },
        {
          name: 'github.repo.list',
          description: 'List GitHub repositories',
          parameters: { type: 'object' },
        },
      ],
      execute,
    } as unknown as ToolRegistry;
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'tool-boundary': provider, ollama: provider }),
      tools,
    });
    const created = runtime.createSession('Tool boundary');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Delete that memory.',
      provider: 'tool-boundary',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('not available for this request'),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toBe(2);
    expect(
      store
        .listEvents()
        .some((event) => event.type === 'tool.failed' && event.payload.reason === 'not_advertised'),
    ).toBe(true);
  });

  it('coerces schema-declared numeric tool arguments from Qwen string output', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const calls: Array<Record<string, unknown>> = [];
    let turn = 0;
    const provider = makeAgentProvider('numeric-tool-arguments', async function* () {
      if (turn++ === 0) {
        yield {
          type: 'tool_call',
          id: 'rows-call',
          name: 'github.repo.list',
          arguments: { mode: 'rows', limit: '50' },
        };
      } else yield { type: 'done', text: 'Rows checked.' };
    });
    const tools = {
      schemas: () => [
        {
          name: 'github.repo.list',
          description: 'List GitHub repositories',
          parameters: {
            type: 'object',
            properties: {
              mode: { type: 'string' },
              limit: { type: 'number' },
            },
          },
        },
      ],
      execute: async (_name: string, input: Record<string, unknown>) => {
        calls.push(input);
        return { exitCode: 0, count: 50, repositories: [] };
      },
    } as unknown as ToolRegistry;
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'numeric-tool-arguments': provider, ollama: provider }),
      tools,
    });
    const created = runtime.createSession('Numeric tool arguments');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'List my GitHub repositories.',
      provider: 'numeric-tool-arguments',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Rows checked.',
    });
    expect(calls).toEqual([{ mode: 'rows', limit: 50 }]);
  });

  it('normalizes the known workspace alias while preserving the raw name in events', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let turn = 0;
    const provider = makeAgentProvider('tool-alias', async function* () {
      if (turn++ === 0)
        yield {
          type: 'tool_call',
          id: 'alias-call',
          name: 'workspace',
          arguments: { command: 'printf alias-verified' },
        };
      else yield { type: 'done', text: 'alias-verified' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'tool-alias': provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'tool.started' || event.type === 'tool.completed')
        events.push({ type: event.type, payload: event.payload });
    });
    const created = runtime.createSession('Tool alias');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Run a command and report its output.',
      provider: 'tool-alias',
      permissions: permissive,
    });
    await vi.waitFor(() => expect(runtime.listApprovals('pending')).toHaveLength(1));
    const [approval] = runtime.listApprovals('pending');
    if (!approval) throw new Error('Expected workspace command approval');
    runtime.approveApproval(approval.id, approval.payloadHash);
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'alias-verified',
    });
    unsubscribe();
    expect(events).toEqual([
      {
        type: 'tool.started',
        payload: {
          id: 'alias-call',
          name: 'workspace.command',
          requestedName: 'workspace',
          arguments: { command: 'printf alias-verified' },
        },
      },
      {
        type: 'tool.completed',
        payload: {
          id: 'alias-call',
          name: 'workspace.command',
          requestedName: 'workspace',
          result: { exitCode: 0, stdout: 'alias-verified', stderr: '' },
          resultBytes: 52,
          resultTruncated: false,
        },
      },
    ]);
  });

  it('does not let model synthesis overwrite an authoritative repository count', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let turn = 0;
    const provider = makeAgentProvider('count-invariant', async function* () {
      const currentTurn = turn++;
      if (currentTurn === 0) {
        yield {
          type: 'tool_call',
          id: 'count-call',
          name: 'github.repo.list',
          arguments: { mode: 'count', limit: 1000 },
        };
      } else if (currentTurn === 1) {
        yield {
          type: 'tool_call',
          id: 'rows-call',
          name: 'github.repo.list',
          arguments: { mode: 'rows', limit: 50 },
        };
      } else yield { type: 'done', text: '34' };
    });
    const tools = {
      schemas: () => [
        {
          name: 'github.repo.list',
          description: 'List GitHub repositories',
          parameters: { type: 'object' },
        },
      ],
      execute: async (_name: string, input: { mode: string; limit: number }) =>
        input.mode === 'count'
          ? { exitCode: 0, count: 152, limit: input.limit }
          : { exitCode: 0, count: 50, repositories: [] },
    } as unknown as ToolRegistry;
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'count-invariant': provider, ollama: provider }),
      tools,
    });
    const created = runtime.createSession('Repository count invariant');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'List my GitHub repositories and report the exact verified count.',
      provider: 'count-invariant',
      permissions: permissive,
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: '152',
    });
  });

  it('persists provider failure details instead of an empty failure output', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = makeAgentProvider('provider-error', async function* () {
      yield { type: 'done', text: '' };
      throw new Error('Ollama request timed out');
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'provider-error': provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Provider failure contract');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'hello',
      provider: 'provider-error',
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output: 'NUAAI could not complete the run: Ollama request timed out',
    });
  });

  it('passes active-run images to the provider without persisting image bytes', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requests: ProviderRequest[] = [];
    const provider = makeAgentProvider('vision', async function* (request) {
      requests.push(request);
      yield { type: 'done', text: 'Image inspected.' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ vision: provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Vision runtime');
    const image: ProviderImage = {
      name: 'photo.png',
      mimeType: 'image/png',
      data: 'aGVsbG8=',
    };
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'inspect this image',
      provider: 'vision',
      images: [image],
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Image inspected.',
    });
    expect(requests[0]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'inspect this image',
      images: [image],
    });
    expect(
      store
        .listMessages(created.thread.id)
        .every((message) => !message.content.includes('aGVsbG8=')),
    ).toBe(true);
  });

  it('routes source keys across resumed, new, and switched sessions', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = new DeterministicProvider();
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ deterministic: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const sourceKey = 'matrix:room:@operator';
    const first = runtime.getOrCreateSession(sourceKey, 'First');
    runtime.getOrCreateThread(first.session.id, `${sourceKey}:main`, 'Main');
    expect(runtime.getOrCreateSession(sourceKey, 'Ignored').session.id).toBe(first.session.id);
    const second = runtime.startNewSession(sourceKey);
    expect(second.session.title).toBe('New session');
    expect(runtime.listSessionsForSource(sourceKey).map((session) => session.id)).toEqual([
      second.session.id,
      first.session.id,
    ]);
    expect(runtime.switchSession(sourceKey, first.session.id).session.id).toBe(first.session.id);
    expect(runtime.getOrCreateThread(first.session.id, `${sourceKey}:main`, 'Main').sessionId).toBe(
      first.session.id,
    );
    const third = runtime.createSession('Third');
    expect(() => runtime.switchSession(sourceKey, third.session.id)).toThrow(
      'does not belong to this source',
    );
    const other = runtime.getOrCreateSession('matrix:room:@other', 'Other');
    expect(() => runtime.switchSession(sourceKey, other.session.id)).toThrow(
      'does not belong to this source',
    );
    expect(runtime.switchSession(sourceKey, first.session.id).session.id).toBe(first.session.id);
  });

  it('reuses a Matrix-created session when the same command event is retried', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = new DeterministicProvider();
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ deterministic: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const sourceKey = 'matrix:room:@operator';
    runtime.getOrCreateSession(sourceKey, 'First');

    const created = runtime.startNewSession(sourceKey, 'Second', 'matrix:$new-command');
    const retried = runtime.startNewSession(sourceKey, 'Changed title', 'matrix:$new-command');

    expect(retried.session.id).toBe(created.session.id);
    expect(retried.thread.id).toBe(created.thread.id);
    expect(runtime.listSessionsForSource(sourceKey)).toHaveLength(2);
  });

  it('executes a real workspace tool call and records tool completion', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let turn = 0;
    const provider = makeAgentProvider('tools', async function* () {
      turn += 1;
      if (turn === 1) {
        yield {
          type: 'tool_call',
          id: 'tool-1',
          name: 'workspace.write',
          arguments: { path: 'tool.txt', content: 'tool output' },
        };
        return;
      }
      yield { type: 'delta', text: 'tool complete' };
      yield { type: 'done', text: 'tool complete' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ tools: provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const events: string[] = [];
    runtime.subscribe((event) => events.push(event.type));
    const created = runtime.createSession('Tool runtime');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'write a workspace file',
      provider: 'tools',
      permissions: permissive,
    });
    await vi.waitFor(() => expect(runtime.listApprovals('pending')).toHaveLength(1));
    const [approval] = runtime.listApprovals('pending');
    if (!approval) throw new Error('Expected workspace write approval');
    runtime.approveApproval(approval.id, approval.payloadHash);
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'tool complete',
    });
    await expect(readWorkspaceFile(root, 'tool.txt')).resolves.toBe('tool output');
    expect(events).toContain('tool.completed');
    expect(store.listThreadArtifacts(created.thread.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool_calls' }),
        expect.objectContaining({ kind: 'tool_result' }),
      ]),
    );
  });

  it('requires a verified final response after tool activity instead of accepting future intent', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requests: ProviderRequest[] = [];
    const provider = makeAgentProvider('finalization', async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        yield {
          type: 'tool_call',
          id: 'tool-1',
          name: 'workspace.list',
          arguments: {},
        };
        return;
      }
      if (requests.length === 2) {
        yield { type: 'done', text: "I'll run a verification suite next." };
        return;
      }
      yield { type: 'done', text: 'Verified the workspace results and completed the request.' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ finalization: provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Finalization contract');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'verify the workspace',
      provider: 'finalization',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Verified the workspace results and completed the request.',
    });
    expect(requests).toHaveLength(3);
    expect(requests[2]?.messages.at(-1)).toMatchObject({ role: 'user' });
    expect(requests[2]?.messages.filter((message) => message.role === 'system')).toHaveLength(0);
    expect(requests[2]?.systemPrompt).toContain('## runtime');
  });

  it('accepts a substantive final answer that quotes unfinished-promise examples', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let requests = 0;
    const report = `${'Verified evidence. '.repeat(80)}The guardrail discusses phrases such as “I’ll check…” and “Let me inspect…” without making either promise. Final conclusion: the requested analysis is complete.`;
    const provider = makeAgentProvider('quoted-final', async function* () {
      requests += 1;
      if (requests === 1) {
        yield { type: 'tool_call', id: 'tool-1', name: 'workspace.list', arguments: {} };
        return;
      }
      yield { type: 'done', text: report };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'quoted-final': provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Quoted final response');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'inspect the workspace and explain the completion guardrail',
      provider: 'quoted-final',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: report,
    });
    expect(requests).toBe(2);
  });

  it('uses one no-tools grace turn after the ordinary model-turn budget', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requests: ProviderRequest[] = [];
    const provider = makeAgentProvider('grace-final', async function* (request) {
      requests.push(request);
      if (request.tools?.length) {
        yield {
          type: 'tool_call',
          id: `tool-${requests.length}`,
          name: 'workspace.list',
          arguments: {},
        };
        return;
      }
      yield { type: 'done', text: 'Final answer from completed tool evidence.' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const defaults = defaultRuntimeConfig(root);
    const runtime = new AgentRuntime({
      root,
      config: {
        ...defaults,
        limits: { ...defaults.limits, maxTurns: 2 },
      },
      store,
      providers: providerMap({ 'grace-final': provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Grace finalization');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'inspect the workspace thoroughly',
      provider: 'grace-final',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Final answer from completed tool evidence.',
    });
    expect(requests).toHaveLength(3);
    expect(requests[2]?.tools).toEqual([]);
  });

  it('enforces the registry cost budget before executing another tool', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let turns = 0;
    let executions = 0;
    const provider = makeAgentProvider('cost-budget', async function* (request) {
      turns += 1;
      if (request.tools?.length && turns <= 2) {
        yield {
          type: 'tool_call',
          id: `cost-${turns}`,
          name: turns === 1 ? 'probe.first' : 'probe.second',
          arguments: {},
        };
        return;
      }
      yield { type: 'done', text: 'Finalized from the first verified probe.' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const tools = new ToolRegistry(root);
    for (const name of ['probe.first', 'probe.second'])
      tools.register({
        name,
        description: 'Run one expensive probe',
        permission: 'read',
        governance: {
          owner: 'probe',
          costClass: 'high',
          authMode: 'none',
          sideEffects: 'none',
          approval: 'none',
          maxCallsPerRun: 8,
        },
        parameters: { type: 'object', properties: {} },
        input: z.object({}),
        execute: async () => ({ executions: ++executions }),
      });
    const defaults = defaultRuntimeConfig(root);
    const runtime = new AgentRuntime({
      root,
      config: {
        ...defaults,
        limits: { ...defaults.limits, maxToolCostUnits: 4 },
      },
      store,
      providers: providerMap({ 'cost-budget': provider, ollama }),
      tools,
    });
    const created = runtime.createSession('Cost budget');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'inspect both probes',
      provider: 'cost-budget',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Finalized from the first verified probe.',
    });
    expect(executions).toBe(1);
    expect(
      store
        .listEvents()
        .some(
          (event) =>
            event.runId === run.id &&
            event.type === 'tool.failed' &&
            event.payload.reason === 'tool_cost_budget_exhausted',
        ),
    ).toBe(true);
  });

  it('reports an unresolved tool failure instead of mislabeling grace exhaustion', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let requests = 0;
    const provider = makeAgentProvider('grace-failure', async function* (request) {
      requests += 1;
      if (request.tools?.length && requests === 1) {
        yield { type: 'tool_call', id: 'tool-1', name: 'probe.fail', arguments: {} };
        return;
      }
      yield { type: 'done', text: 'The action could not be completed.' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const tools = new ToolRegistry(root);
    tools.register({
      name: 'probe.fail',
      description: 'Fail one simulated action',
      permission: 'read',
      governance: {
        owner: 'probe',
        costClass: 'low',
        authMode: 'none',
        sideEffects: 'none',
        approval: 'none',
        maxCallsPerRun: 2,
      },
      parameters: { type: 'object', properties: {} },
      input: z.object({}),
      execute: async () => {
        throw new Error('simulated action failure');
      },
    });
    const defaults = defaultRuntimeConfig(root);
    const runtime = new AgentRuntime({
      root,
      config: { ...defaults, limits: { ...defaults.limits, maxTurns: 1 } },
      store,
      providers: providerMap({ 'grace-failure': provider, ollama }),
      tools,
    });
    const created = runtime.createSession('Grace failure truth');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'inspect the workspace',
      provider: 'grace-failure',
      permissions: permissive,
    });

    const completed = await runtime.waitForRun(run.id);
    expect(completed).toMatchObject({
      status: 'failed',
      output: expect.stringContaining('tool failed: probe.fail: simulated action failure'),
    });
    expect(completed.output).not.toContain('tool-turn limit');
  });

  it('keeps provider message roles alternating when grace follows a recovery prompt', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requestRoles: string[][] = [];
    const provider = makeAgentProvider('grace-roles', async function* (request) {
      requestRoles.push(request.messages.map((message) => message.role));
      if (requestRoles.length === 1) {
        yield { type: 'tool_call', id: 'tool-1', name: 'probe.fail', arguments: {} };
        return;
      }
      yield { type: 'done', text: 'The action could not be completed.' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const tools = new ToolRegistry(root);
    tools.register({
      name: 'probe.fail',
      description: 'Fail one simulated action',
      permission: 'read',
      governance: {
        owner: 'probe',
        costClass: 'low',
        authMode: 'none',
        sideEffects: 'none',
        approval: 'none',
        maxCallsPerRun: 2,
      },
      parameters: { type: 'object', properties: {} },
      input: z.object({}),
      execute: async () => {
        throw new Error('simulated action failure');
      },
    });
    const defaults = defaultRuntimeConfig(root);
    const runtime = new AgentRuntime({
      root,
      config: { ...defaults, limits: { ...defaults.limits, maxTurns: 2 } },
      store,
      providers: providerMap({ 'grace-roles': provider, ollama }),
      tools,
    });
    const created = runtime.createSession('Grace role alternation');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'inspect the workspace',
      provider: 'grace-roles',
      permissions: permissive,
    });

    await runtime.waitForRun(run.id);
    expect(requestRoles).toHaveLength(3);
    expect(
      requestRoles[2]?.some((role, index, roles) => role === 'user' && roles[index - 1] === 'user'),
    ).toBe(false);
  });

  it('batches tiny provider deltas without losing the completed response', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const response = `${'streamed evidence '.repeat(240)}complete`;
    const provider = makeAgentProvider('tiny-deltas', async function* () {
      for (const character of response) yield { type: 'delta', text: character };
      yield { type: 'done', text: '' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'tiny-deltas': provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const deltas: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === 'model.delta') deltas.push(String(event.payload.text ?? ''));
    });
    const created = runtime.createSession('Batched stream');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'write a long response',
      provider: 'tiny-deltas',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: response,
    });
    expect(deltas.join('')).toBe(response);
    expect(deltas.length).toBeLessThan(100);
  });

  it('enforces maxOutputBytes across all generated model attempts', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let turn = 0;
    const provider = makeAgentProvider('cumulative-output', async function* () {
      turn += 1;
      if (turn === 1) {
        yield { type: 'delta', text: 'a'.repeat(600) };
        yield { type: 'tool_call', id: 'tool-1', name: 'workspace.list', arguments: {} };
        return;
      }
      yield { type: 'done', text: 'b'.repeat(600) };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const defaults = defaultRuntimeConfig(root);
    const runtime = new AgentRuntime({
      root,
      config: { ...defaults, limits: { ...defaults.limits, maxOutputBytes: 1_000 } },
      store,
      providers: providerMap({ 'cumulative-output': provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Cumulative output');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'inspect and report',
      provider: 'cumulative-output',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('Run output limit exceeded'),
    });
  });

  it('flushes a short pending delta while the provider remains paused', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let releaseProvider: (() => void) | undefined;
    const providerHold = new Promise<void>((resolvePromise) => {
      releaseProvider = resolvePromise;
    });
    let deltaReceived: (() => void) | undefined;
    const providerPaused = new Promise<void>((resolvePromise) => {
      deltaReceived = resolvePromise;
    });
    const provider = makeAgentProvider('timed-delta', async function* () {
      yield { type: 'delta', text: 'ok' };
      deltaReceived?.();
      await providerHold;
      yield { type: 'done', text: '' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'timed-delta': provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Timed delta');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'say ok',
      provider: 'timed-delta',
      permissions: permissive,
    });

    await providerPaused;
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      expect(store.getRun(run.id)?.output).toBe('ok');
      expect(
        store.listEvents().some((event) => event.runId === run.id && event.type === 'model.delta'),
      ).toBe(true);
    } finally {
      releaseProvider?.();
    }
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'ok',
    });
  });

  it('requests finalization for a polite promise-only response', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let requests = 0;
    const provider = makeAgentProvider('polite-promise', async function* () {
      requests += 1;
      if (requests === 1) {
        yield { type: 'tool_call', id: 'tool-1', name: 'workspace.list', arguments: {} };
        return;
      }
      yield {
        type: 'done',
        text:
          requests === 2
            ? "Sure, I'll check the remaining files next."
            : 'Verified final answer from completed tool evidence.',
      };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'polite-promise': provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Polite promise');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'inspect the workspace',
      provider: 'polite-promise',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Verified final answer from completed tool evidence.',
    });
    expect(requests).toBe(3);
  });

  it('keeps a non-empty final response when tool activity reaches the turn limit', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let requests = 0;
    const provider = makeAgentProvider('bounded-final', async function* () {
      requests += 1;
      if (requests === 1) {
        yield { type: 'tool_call', id: 'tool-1', name: 'workspace.list', arguments: {} };
        return;
      }
      yield { type: 'done', text: 'The workspace inspection is complete.' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const defaults = defaultRuntimeConfig(root);
    const runtime = new AgentRuntime({
      root,
      config: {
        ...defaults,
        limits: { ...defaults.limits, maxTurns: 2 },
      },
      store,
      providers: providerMap({ 'bounded-final': provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Bounded final response');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'inspect the workspace',
      provider: 'bounded-final',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'The workspace inspection is complete.',
    });
  });

  it('fails with an explicit message when tool activity reaches the turn limit without final text', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = makeAgentProvider('turn-limit', async function* () {
      yield { type: 'tool_call', id: 'tool-1', name: 'workspace.list', arguments: {} };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const defaults = defaultRuntimeConfig(root);
    const runtime = new AgentRuntime({
      root,
      config: {
        ...defaults,
        limits: { ...defaults.limits, maxTurns: 2 },
      },
      store,
      providers: providerMap({ 'turn-limit': provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Turn limit failure');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'inspect workspace forever',
      provider: 'turn-limit',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output:
        'NUAAI could not verify completion: the tool-turn limit was reached before a final response.',
    });
  });

  it('fails a run when a tool error remains unresolved instead of reporting success', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = makeAgentProvider('unresolved', async function* (request) {
      const toolCalls = request.messages.filter((message) => message.role === 'assistant').length;
      if (toolCalls === 0) {
        yield { type: 'tool_call', id: 'tool-1', name: 'missing.tool', arguments: {} };
        return;
      }
      yield { type: 'done', text: "I'll deal with that later." };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ unresolved: provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Unresolved tool error');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'complete the missing tool task',
      provider: 'unresolved',
      permissions: permissive,
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('could not verify completion'),
    });
  });

  it('preserves the assistant tool call and named tool result for the next Ollama turn', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requests: ProviderRequest[] = [];
    const provider = makeAgentProvider('tools', async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        yield {
          type: 'tool_call',
          id: 'tool-1',
          name: 'workspace.list',
          arguments: {},
        };
        return;
      }
      yield { type: 'done', text: 'files inspected' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ tools: provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Tool protocol');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'inspect files',
      provider: 'tools',
      permissions: permissive,
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'files inspected',
    });
    expect(requests[1]?.messages).toEqual(
      expect.arrayContaining([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tool-1', name: 'workspace.list', arguments: {} }],
        },
        {
          role: 'tool',
          content: expect.any(String),
          toolCallId: 'tool-1',
          toolName: 'workspace.list',
        },
      ]),
    );
  });

  it('reports tool failures, enforces tool-call limits, and executes MCP tools', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let turn = 0;
    const provider = makeAgentProvider('tools', async function* () {
      turn += 1;
      if (turn === 1) {
        yield { type: 'tool_call', id: 'tool-1', name: 'missing.tool', arguments: {} };
        return;
      }
      if (turn === 2) {
        yield { type: 'tool_call', id: 'tool-2', name: 'mcp.local.echo', arguments: {} };
        return;
      }
      yield { type: 'done', text: 'recovered from tool failure' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const events: string[] = [];
    const mcp = {
      schemas: () => [
        {
          name: 'mcp.local.echo',
          description: 'Echo through MCP',
          parameters: { type: 'object' },
        },
      ],
      execute: async () => ({ echoed: true }),
    };
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ tools: provider, ollama }),
      tools: new ToolRegistry(root),
      mcp: mcp as never,
    });
    runtime.subscribe((event) => events.push(event.type));
    const created = runtime.createSession('Tool failure');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'recover from a workspace and MCP tool failure',
      provider: 'tools',
      permissions: permissive,
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'recovered from tool failure',
    });
    expect(events).toContain('tool.failed');
    expect(
      store
        .listMessages(created.thread.id)
        .some((message) => message.content.includes('not available for this request')),
    ).toBe(true);

    let mcpTurn = 0;
    const mcpProvider = makeAgentProvider('mcp-tools', async function* () {
      mcpTurn += 1;
      if (mcpTurn === 1) {
        yield { type: 'tool_call', id: 'mcp-1', name: 'mcp.local.echo', arguments: {} };
        return;
      }
      yield { type: 'done', text: 'MCP complete' };
    });
    const mcpRuntime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'mcp-tools': mcpProvider, ollama }),
      tools: new ToolRegistry(root),
      mcp: mcp as never,
    });
    const mcpSession = mcpRuntime.createSession('MCP runtime');
    const mcpRun = mcpRuntime.startRun({
      threadId: mcpSession.thread.id,
      input: 'use MCP',
      provider: 'mcp-tools',
      permissions: permissive,
    });
    await expect(mcpRuntime.waitForRun(mcpRun.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'MCP complete',
    });

    let limitedTurn = 0;
    const limitedRequests: ProviderRequest[] = [];
    const limitedProvider = makeAgentProvider('limited', async function* (request) {
      limitedRequests.push(request);
      limitedTurn += 1;
      if (limitedTurn === 1) {
        yield { type: 'tool_call', id: 'limited-1', name: 'workspace.list', arguments: {} };
        yield { type: 'tool_call', id: 'limited-2', name: 'workspace.list', arguments: {} };
        return;
      }
      yield { type: 'done', text: 'final answer from gathered evidence' };
    });
    const limitedRuntime = new AgentRuntime({
      root,
      config: {
        ...defaultRuntimeConfig(root),
        limits: { ...defaultRuntimeConfig(root).limits, maxToolCalls: 1 },
      },
      store,
      providers: providerMap({ limited: limitedProvider, ollama }),
      tools: new ToolRegistry(root),
    });
    const limitedSession = limitedRuntime.createSession('Tool limit');
    const limitedRun = limitedRuntime.startRun({
      threadId: limitedSession.thread.id,
      input: 'exceed',
      provider: 'limited',
      permissions: permissive,
    });
    await expect(limitedRuntime.waitForRun(limitedRun.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'final answer from gathered evidence',
    });
    expect(limitedRequests[1]?.tools).toEqual([]);
    expect(limitedRequests[1]?.messages.at(-1)?.content).toContain('tool-call budget');
    expect(
      store
        .listEvents()
        .filter((event) => event.runId === limitedRun.id && event.type.startsWith('tool.'))
        .map((event) => ({ type: event.type, id: event.payload.id, reason: event.payload.reason })),
    ).toEqual([
      { type: 'tool.started', id: 'limited-1', reason: undefined },
      { type: 'tool.completed', id: 'limited-1', reason: undefined },
      { type: 'tool.failed', id: 'limited-2', reason: 'tool_budget_exhausted' },
    ]);
  });

  it('persists exceptional run failures into the next turn context', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requests: ProviderRequest[] = [];
    const failing = makeAgentProvider('failing', async function* (request) {
      requests.push(request);
      if (requests.length === 1) throw new Error('provider exploded');
      yield { type: 'done', text: 'The previous failure is visible.' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ failing, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Failure continuity');
    const failed = runtime.startRun({
      threadId: created.thread.id,
      input: 'Perform a bounded task.',
      provider: 'failing',
    });
    await expect(runtime.waitForRun(failed.id)).resolves.toMatchObject({
      status: 'failed',
      output: 'NUAAI could not complete the run: provider exploded',
    });
    expect(store.listMessages(created.thread.id).at(-1)).toMatchObject({
      role: 'assistant',
      content: 'NUAAI could not complete the run: provider exploded',
    });

    const followUp = runtime.startRun({
      threadId: created.thread.id,
      input: 'What happened?',
      provider: 'failing',
    });
    await expect(runtime.waitForRun(followUp.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'The previous failure is visible.',
    });
    expect(requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'NUAAI could not complete the run: provider exploded',
        }),
      ]),
    );
  });

  it('falls back to lexical automatic memory retrieval when embeddings are unavailable', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    store.storeMemory(
      'memory-lexical',
      'Code reviews should cite concrete evidence from the implementation.',
      null,
      {},
    );
    const requests: ProviderRequest[] = [];
    const provider = makeAgentProvider('recall', async function* (request) {
      requests.push(request);
      yield { type: 'done', text: 'Memory checked.' };
    });
    const ollama = makeAgentProvider(
      'ollama',
      async function* () {
        yield { type: 'done', text: '' };
      },
      async () => {
        throw new Error('embedding endpoint unavailable');
      },
    );
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ recall: provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Lexical recall');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'How should code reviews cite concrete evidence?',
      provider: 'recall',
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(requests[0]?.systemPrompt).toContain(
      'Code reviews should cite concrete evidence from the implementation.',
    );
    expect(
      store
        .listEvents()
        .find((event) => event.runId === run.id && event.type === 'memory.retrieved')?.payload,
    ).toMatchObject({ count: 1, mode: 'lexical' });
  });

  it('bounds long context and does not persist capability refusals after embedding failure', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const refusalProvider = makeAgentProvider(
      'refusal',
      async function* () {
        yield { type: 'done', text: "I can't access the requested workspace." };
      },
      async () => {
        throw 'embedding unavailable';
      },
    );
    const runtime = new AgentRuntime({
      root,
      config: {
        ...defaultRuntimeConfig(root),
        limits: { ...defaultRuntimeConfig(root).limits, maxContextBytes: 80 },
      },
      store,
      providers: providerMap({ refusal: refusalProvider, ollama: refusalProvider }),
      tools: new ToolRegistry(root),
      identityContext: 'bounded identity',
    });
    const created = runtime.createSession('Bounded context');
    store.addMessage(created.thread.id, 'user', 'old message '.repeat(20));
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Check the latest workspace status.',
      provider: 'refusal',
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('rejected an unverified capability claim'),
    });
    expect(store.searchMemoryRows()).toHaveLength(0);
  });

  it('bounds memory injection and isolates memory mutations from prior context', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const requests: ProviderRequest[] = [];
    vi.spyOn(store, 'searchMemory').mockReturnValue([
      {
        id: 'memory-a',
        content: 'A'.repeat(1000),
        metadata: {},
        distance: 0,
        createdAt: 1,
      },
      {
        id: 'memory-b',
        content: 'B'.repeat(1000),
        metadata: {},
        distance: 0.1,
        createdAt: 2,
      },
    ]);
    const provider = makeAgentProvider('bounded-memory', async function* (request) {
      requests.push(request);
      yield { type: 'done', text: 'Context checked.' };
    });
    const defaults = defaultRuntimeConfig(root);
    const runtime = new AgentRuntime({
      root,
      config: {
        ...defaults,
        limits: { ...defaults.limits, maxContextBytes: 400, maxMemoryContextBytes: 100 },
      },
      store,
      providers: providerMap({ 'bounded-memory': provider, ollama: provider }),
      tools: new ToolRegistry(root),
      identityContext: 'session instructions',
    });
    const created = runtime.createSession('Bounded memory');
    store.addMessage(created.thread.id, 'assistant', 'old conversation that must be bounded');

    const contextualRun = runtime.startRun({
      threadId: created.thread.id,
      input: 'What do you remember about this project?',
      provider: 'bounded-memory',
    });
    await expect(runtime.waitForRun(contextualRun.id)).resolves.toMatchObject({
      status: 'completed',
    });
    const contextualSystem = requests[0]?.messages[0]?.content ?? '';
    const memorySection = contextualSystem.split('Relevant persisted memory:\n')[1] ?? '';
    expect(Buffer.byteLength(memorySection, 'utf8')).toBeLessThanOrEqual(100);
    expect(
      requests[0]?.messages.some((message) =>
        message.content.includes('old conversation that must be bounded'),
      ),
    ).toBe(true);

    const mutationRun = runtime.startRun({
      threadId: created.thread.id,
      input: 'Delete that memory.',
      provider: 'bounded-memory',
    });
    await expect(runtime.waitForRun(mutationRun.id)).resolves.toMatchObject({
      status: 'failed',
    });
    const mutationSystem = requests[1]?.messages[0]?.content ?? '';
    expect(mutationSystem).not.toContain('Relevant persisted memory:');
    expect(
      requests[1]?.messages.some((message) =>
        message.content.includes('old conversation that must be bounded'),
      ),
    ).toBe(false);
    expect(
      store
        .listEvents()
        .some(
          (event) =>
            event.type === 'memory.retrieved' && event.payload.skipped === 'memory_mutation',
        ),
    ).toBe(true);
  });

  it('reports run timeouts as failures without calling them user cancellations', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const hanging = makeAgentProvider('hanging', async function* (request) {
      await new Promise<void>((resolvePromise) => {
        if (request.signal?.aborted) return resolvePromise();
        request.signal?.addEventListener('abort', () => resolvePromise(), { once: true });
      });
      if (request.signal?.aborted) return;
      yield { type: 'done', text: 'unreachable' };
    });
    const timeoutRuntime = new AgentRuntime({
      root,
      config: {
        ...defaultRuntimeConfig(root),
        limits: { ...defaultRuntimeConfig(root).limits, runTimeoutMs: 10 },
      },
      store,
      providers: providerMap({ hanging, ollama: hanging }),
      tools: new ToolRegistry(root),
    });
    const timeoutSession = timeoutRuntime.createSession('Timeout');
    const timed = timeoutRuntime.startRun({
      threadId: timeoutSession.thread.id,
      input: 'wait',
      provider: 'hanging',
    });
    await expect(timeoutRuntime.waitForRun(timed.id)).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('timed out'),
    });
  });

  it('only advertises tools allowed by the run permission context', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let request: ProviderRequest | undefined;
    const provider = makeAgentProvider('tools', async function* (value) {
      request = value;
      yield { type: 'done', text: 'ok' };
    });
    const ollama = makeAgentProvider('ollama', async function* () {
      yield { type: 'done', text: '' };
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ tools: provider, ollama }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Tool permissions');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'read files',
      provider: 'tools',
      permissions: { approved: new Set(['read']), capabilities: { filesystem: true } },
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({ status: 'completed' });
    const names = request?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain('workspace.list');
    expect(names).toContain('workspace.read');
    expect(names).not.toContain('workspace.write');
    expect(names).not.toContain('workspace.command');
  });

  it('propagates run cancellation into provider-driven MCP calls', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let turn = 0;
    const provider = makeAgentProvider('mcp-cancel', async function* () {
      turn += 1;
      if (turn === 1) {
        yield { type: 'tool_call', id: 'mcp-cancel-1', name: 'mcp.local.wait', arguments: {} };
        return;
      }
      yield { type: 'done', text: 'unreachable' };
    });
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolvePromise) => {
      startedResolve = resolvePromise;
    });
    let abortedResolve: (() => void) | undefined;
    const aborted = new Promise<void>((resolvePromise) => {
      abortedResolve = resolvePromise;
    });
    const mcp = {
      schemas: () => [
        {
          name: 'mcp.local.wait',
          description: 'Wait until cancelled',
          parameters: { type: 'object' },
        },
      ],
      execute: async (
        _name: string,
        _arguments: Record<string, unknown>,
        _permissions: unknown,
        signal?: AbortSignal,
      ) =>
        new Promise<never>((_resolvePromise, reject) => {
          startedResolve?.();
          const timer = setTimeout(
            () => reject(new Error('MCP cancellation probe timed out')),
            250,
          );
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              abortedResolve?.();
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    };
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ 'mcp-cancel': provider, ollama: provider }),
      tools: new ToolRegistry(root),
      mcp: mcp as never,
    });
    const created = runtime.createSession('MCP cancellation');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'cancel the MCP call',
      provider: 'mcp-cancel',
    });
    await started;

    runtime.cancelRun(run.id);

    expect(
      await Promise.race([
        aborted.then(() => true),
        new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 50)),
      ]),
    ).toBe(true);
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('cancels a running stream and records provider failures truthfully', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const hanging = makeAgentProvider('hanging', async function* (request) {
      await new Promise<void>((resolvePromise) => {
        if (request.signal?.aborted) return resolvePromise();
        request.signal?.addEventListener('abort', () => resolvePromise(), { once: true });
      });
      if (request.signal?.aborted) return;
      yield { type: 'done', text: 'unexpected' };
    });
    const failing = makeAgentProvider(
      'failing',
      async function* () {
        yield* [] as ProviderStreamEvent[];
        throw new Error('provider exploded');
      },
      async () => {
        throw new Error('embedding unavailable');
      },
    );
    const runtime = new AgentRuntime({
      root,
      config: {
        ...defaultRuntimeConfig(root),
        limits: { ...defaultRuntimeConfig(root).limits, runTimeoutMs: 5_000 },
      },
      store,
      providers: providerMap({ hanging, failing, ollama: failing }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Cancellation');
    const cancelled = runtime.startRun({
      threadId: created.thread.id,
      input: 'stop',
      provider: 'hanging',
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    runtime.cancelRun(cancelled.id);
    await expect(runtime.waitForRun(cancelled.id)).resolves.toMatchObject({ status: 'cancelled' });
    const preCancelledRuntime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ hanging, ollama: hanging }),
      tools: new ToolRegistry(root),
    });
    const preCancelledSession = preCancelledRuntime.createSession('Pre-cancelled');
    const preCancelled = preCancelledRuntime.startRun({
      threadId: preCancelledSession.thread.id,
      input: 'stop before model',
      provider: 'hanging',
    });
    preCancelledRuntime.cancelRun(preCancelled.id);
    await expect(preCancelledRuntime.waitForRun(preCancelled.id)).resolves.toMatchObject({
      status: 'cancelled',
    });
    const failed = runtime.startRun({
      threadId: created.thread.id,
      input: 'fail',
      provider: 'failing',
    });
    await expect(runtime.waitForRun(failed.id)).resolves.toMatchObject({ status: 'failed' });
  });

  it('aborts active work, drains the run queue, and rejects new runs during shutdown', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    let aborted = false;
    const provider = makeAgentProvider('shutdown', async function* (request) {
      await new Promise<void>((resolvePromise) => {
        if (request.signal?.aborted) return resolvePromise();
        request.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolvePromise();
          },
          { once: true },
        );
      });
    });
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ shutdown: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Shutdown');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'wait until shutdown',
      provider: 'shutdown',
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    await runtime.shutdown();

    expect(aborted).toBe(true);
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({ status: 'cancelled' });
    expect(() => runtime.startRun({ threadId: created.thread.id, input: 'too late' })).toThrow(
      'Runtime is shutting down',
    );
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it('marks persisted runs interrupted and only resumes them after an explicit request', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const created = store.createSession('Recovery');
    const provider = new DeterministicProvider();
    const run = store.createRun(
      created.thread.id,
      'recover me',
      'deterministic',
      'local-test',
      'recovery-correlation',
    );
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ deterministic: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('interrupted by daemon restart'),
    });
    const failed = store.createRun(
      created.thread.id,
      'resume me',
      'deterministic',
      'local-test',
      'resume-correlation',
    );
    store.updateRun(failed.id, { status: 'failed' });
    const resumed = runtime.resumeRun(failed.id);
    await expect(runtime.waitForRun(resumed.id)).resolves.toMatchObject({ status: 'completed' });
    const unrecoverable = store.createRun(
      created.thread.id,
      'cannot recover',
      'missing-provider',
      'missing-model',
      'missing-correlation',
    );
    new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap({ deterministic: provider, ollama: provider }),
      tools: new ToolRegistry(root),
    });
    expect(store.getRun(unrecoverable.id)).toMatchObject({ status: 'failed' });
  });
});
