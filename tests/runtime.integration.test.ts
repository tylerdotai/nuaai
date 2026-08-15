import { chmod, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
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
  workspaceDirectory,
} from '../src/config/index.js';
import { createEvent } from '../src/core/events.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { Scheduler, nextCronRun } from '../src/core/scheduler.js';
import { acquireDaemonLock, daemonLockExists } from '../src/gateway/lock.js';
import { ensureRuntimeIdentity } from '../src/gateway/runtime.js';
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
  ProviderRequest,
  ProviderStreamEvent,
} from '../src/providers/types.js';
import { decryptSecret, encryptSecret, rotateSecret } from '../src/security/encryption.js';
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
    expect(parseRuntimeConfig({ provider: { name: 'codex' } }, root)).toMatchObject({
      name: 'NUAAI',
      provider: { name: 'codex', model: '' },
    });
    expect(
      parseRuntimeConfig({ provider: { name: 'codex', model: 'gpt-live' } }, root),
    ).toMatchObject({
      provider: { name: 'codex', model: 'gpt-live' },
    });
    expect(workspaceDirectory(root)).toBe(join(root, '.nuaai'));
    await expect(loadRuntimeConfig(root)).resolves.toMatchObject({ name: 'NUAAI', version: 1 });
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
  });

  it('prevents duplicate daemon locks and releases ownership safely', async () => {
    const root = await makeRoot();
    const first = await acquireDaemonLock(root);
    await expect(acquireDaemonLock(root)).rejects.toThrow('Daemon already running');
    await first.release();
    const second = await acquireDaemonLock(root);
    await second.release();
  });

  it('reclaims malformed and stale daemon locks without deleting another owner', async () => {
    const root = await makeRoot();
    const lockPath = join(root, '.nuaai', 'daemon.lock');
    expect(await daemonLockExists(root)).toBe(false);

    await writeFile(lockPath, 'not-json\n');
    const malformed = await acquireDaemonLock(root);
    expect(await daemonLockExists(root)).toBe(true);
    await malformed.release();

    await writeFile(lockPath, JSON.stringify({ pid: 0, owner: 'stale' }));
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
});

describe('SQLite persistence and vector memory', () => {
  it('persists sessions, messages, runs, events, memory, secrets, and schedules', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    expect(
      (
        store.database.raw
          .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
          .get() as {
          value: string;
        }
      ).value,
    ).toBe('3');
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
    ).toBe('3');
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
    expect(tools.list()).toHaveLength(5);
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
        { command: process.execPath, args: ['-e', 'process.stdout.write("ok")'] },
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
      crawl4ai: {
        crawl: async () => ({ url: 'https://example.com', title: 'page', text: 'body' }),
      },
    });
    const networkTools = new ToolRegistry(root, searchStack, { browserEnabled: false });
    const networkPermissions: PermissionContext = {
      ...permissive,
      capabilities: { ...permissive.capabilities, network: true },
    };
    expect(networkTools.schemas().map((tool) => tool.name)).toContain('web.search');
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
    ).resolves.toMatchObject({ text: 'body' });
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
    await expect(readWorkspaceFile(root, 'skills')).rejects.toThrow('Not a regular file');
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
    await expect(
      runWorkspaceCommand(process.execPath, ['-e', 'process.exit(3)'], root),
    ).resolves.toMatchObject({ exitCode: 3 });
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
      expect(() => registry.get('missing')).toThrow('Unknown provider');
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

  it('parses Ollama streaming, modern and legacy embeddings, and health states', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/chat'))
        return responseStream([
          JSON.stringify({ message: { content: 'Hello ' } }),
          JSON.stringify({ message: { content: 'world' }, done: true }),
        ]);
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
        messages: [{ role: 'user', content: 'hi' }],
      }))
        events.push(event);
      expect(events).toEqual([
        { type: 'delta', text: 'Hello ' },
        { type: 'delta', text: 'world' },
        { type: 'done', text: 'Hello world' },
      ]);
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
      }))
        events.push(event);
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

  it('executes Codex through a real subprocess boundary', async () => {
    const root = await makeRoot();
    const executable = join(root, 'codex-fake.mjs');
    const argsPath = join(root, 'codex-args.json');
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
if (process.argv.includes('--version')) process.stdout.write('codex-fake 1\\n');
else process.stdout.write(JSON.stringify({ item: { type: 'error', message: 'non-fatal warning' } }) + '\\n' + JSON.stringify({ item: { text: 'hello' } }) + '\\n' + JSON.stringify({ item: { text: 'hello world' } }) + '\\n');
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
      messages: [{ role: 'user', content: 'hello' }],
    }))
      events.push(event);
    expect(events).toEqual([
      { type: 'delta', text: 'hello' },
      { type: 'delta', text: ' world' },
      { type: 'done', text: 'hello world' },
    ]);
    const explicitArgs = JSON.parse(await readFile(argsPath, 'utf8')) as string[];
    expect(explicitArgs).toContain('--json');
    expect(explicitArgs).toContain('--model');
    expect(explicitArgs).toContain('model');
    expect(explicitArgs).not.toContain('--ask-for-approval');
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
    expect(runtime.listMessages(created.thread.id).map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(store.searchMemoryRows()).toHaveLength(1);
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
        'memory.stored',
      ]),
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
      input: 'write it',
      provider: 'tools',
      permissions: permissive,
    });
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'tool complete',
    });
    await expect(readWorkspaceFile(root, 'tool.txt')).resolves.toBe('tool output');
    expect(events).toContain('tool.completed');
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

  it('resumes queued runs from persistence after runtime construction', async () => {
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
      status: 'completed',
      output: 'NUAAI deterministic test response',
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
