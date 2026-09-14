import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PermissionContext } from '../src/security/permissions.js';
import { type ToolContext, ToolRegistry } from '../src/tools/registry.js';
import { initWorkspace, writeWorkspaceFile } from '../src/workspace/fs.js';

const allPermissions: PermissionContext = {
  approved: new Set(['read', 'write', 'execute', 'secret']),
  capabilities: { filesystem: true, subprocess: true, network: true },
};

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-tools-'));
  await initWorkspace(root);
  return root;
}

function services() {
  const memoryRows = [
    { id: 'memory-1', content: 'local Ollama vision', metadata: {}, createdAt: 1, embedding: null },
  ];
  const calls: string[] = [];
  const providers = {
    get: () => ({
      embed: async () => [1, 0, 0],
    }),
    catalog: async () => ({ active: { name: 'ollama', model: 'local' }, providers: [] }),
    switch: async (provider: string, model: string) => ({ name: provider, model }),
  };
  const scheduler = {
    create: async (input: unknown) => ({ id: 'schedule-1', ...((input ?? {}) as object) }),
    list: () => [{ id: 'schedule-1' }],
    update: (id: string, changes: unknown) => ({ id, ...((changes ?? {}) as object) }),
    pause: async (id: string) => calls.push(`pause:${id}`),
    resume: async (id: string) => calls.push(`resume:${id}`),
    trigger: async (id: string) => calls.push(`trigger:${id}`),
    createTask: async (input: string, name?: string) => ({ id: 'task-1', input, name }),
    listTasks: () => [{ id: 'task-1', status: 'queued' }],
    cancelTask: (id: string) => calls.push(`cancel:${id}`),
  };
  const mcp = {
    status: () => ({
      servers: ['computer'],
      failures: {},
      tools: [{ name: 'mcp.computer.capture', server: 'computer' }],
    }),
    discover: async () => [{ name: 'mcp.computer.capture' }],
    executeComputer: async (action: string) => ({ action }),
    execute: async (name: string) => ({ name }),
  };
  const media = { inspect: async (path: string) => ({ path, kind: 'text' }) };
  const agents = {
    list: () => ['local-agent'],
    dispatch: async (agent: string, prompt: string) => ({ agent, prompt, ok: true }),
  };
  const store = {
    storeMemory: (id: string, content: string) => {
      memoryRows.push({ id, content, metadata: {}, createdAt: 2, embedding: null });
    },
    searchMemory: () => [{ id: 'memory-1', content: 'semantic result' }],
    searchMemoryRows: () => memoryRows,
    searchMemoryLexical: () => memoryRows.map(({ embedding: _embedding, ...memory }) => memory),
    deleteMemory: (id: string) => id === 'memory-1',
    listRuns: (threadId: string, limit: number) =>
      [
        {
          id: 'run-1',
          threadId,
          status: 'failed',
          provider: 'codex',
          model: 'gpt-test',
          input: 'review the code',
          output: 'Run tool-call limit exceeded',
          cancelRequested: false,
          createdAt: 2,
          updatedAt: 3,
          correlationId: 'private-correlation',
        },
      ].slice(0, limit),
  };
  const search = {
    search: async (query: string, limit: number) => ({ query, limit, results: ['result'] }),
    fetch: async (url: string) => ({ url, content: 'page' }),
    open: async (url: string) => ({ url, title: 'page' }),
  };
  return { store, scheduler, providers, mcp, media, agents, search, calls };
}

describe('model-facing tool registry contracts', () => {
  it('exposes browser automation independently of search when configured that way', async () => {
    const root = await makeRoot();
    const stack = {
      open: async (url: string) => ({ url, title: 'opened', text: 'browser output' }),
    };
    const registry = new ToolRegistry(root, stack as never, {
      browserEnabled: true,
      searchEnabled: false,
    });

    expect(registry.schemas().some((tool) => tool.name === 'browser.open')).toBe(true);
    expect(registry.schemas().some((tool) => tool.name === 'web.search')).toBe(false);
    expect(registry.schemas().some((tool) => tool.name === 'web.fetch')).toBe(false);
    await expect(
      registry.execute(
        'browser.open',
        { url: 'https://example.com' },
        {
          root,
          permissions: {
            approved: new Set(['read']),
            capabilities: { network: true },
          },
        },
      ),
    ).resolves.toMatchObject({ title: 'opened', text: 'browser output' });
  });

  it('does not advertise page fetching when search is enabled without browser automation', () => {
    const root = '/tmp/nuaai-search-only-test';
    const stack = {
      search: async () => [],
      fetch: async () => ({ url: 'https://example.com', title: 'page', text: 'body' }),
      open: async () => ({ url: 'https://example.com', title: 'page', text: 'body' }),
    };
    const registry = new ToolRegistry(root, stack as never, {
      browserEnabled: false,
      searchEnabled: true,
    });
    const names = registry.schemas().map((tool) => tool.name);

    expect(names).toContain('web.search');
    expect(names).not.toContain('web.fetch');
    expect(names).not.toContain('browser.open');
  });

  it('executes workspace, web, memory, schedule, provider, MCP, media, and agent tools', async () => {
    const root = await makeRoot();
    await writeWorkspaceFile(root, 'note.txt', 'vision and schedule');
    const dependencies = services();
    const registry = new ToolRegistry(
      root,
      dependencies.search as never,
      { browserEnabled: true },
      dependencies as never,
    );
    const context = {
      root,
      permissions: allPermissions,
      timeoutMs: 5_000,
      threadId: 'thread-1',
      runId: 'run-current',
    };

    expect(
      ((await registry.execute('workspace.list', {}, context)) as unknown[]).length,
    ).toBeGreaterThan(0);
    expect(await registry.execute('workspace.read', { path: 'note.txt' }, context)).toBe(
      'vision and schedule',
    );
    expect(
      (await registry.execute('workspace.inspect', { path: 'note.txt' }, context)) as {
        extension: string;
        textPreview: string;
      },
    ).toMatchObject({
      extension: '.txt',
      textPreview: 'vision and schedule',
    });
    expect(
      await registry.execute('workspace.write', { path: 'out.txt', content: 'written' }, context),
    ).toEqual({
      written: 'out.txt',
    });
    expect(
      ((await registry.execute('workspace.search', { query: 'vision' }, context)) as unknown[])
        .length,
    ).toBe(1);
    expect(
      await registry.execute('workspace.command', { command: 'printf', args: ['ok'] }, context),
    ).toMatchObject({
      stdout: 'ok',
    });
    expect(registry.schemas(allPermissions).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['github.auth', 'github.repo.list']),
    );
    const webFetchSchema = registry
      .schemas(allPermissions)
      .find((tool) => tool.name === 'web.fetch');
    expect(webFetchSchema?.description).toContain('guarded Playwright');
    expect(webFetchSchema?.description).not.toMatch(/Crawl4AI|FlareSolverr/);
    await expect(
      registry.execute('github.repo.list', { mode: 'count', limit: 1_001 }, context),
    ).rejects.toThrow();
    expect(
      await registry.execute('web.search', { query: 'local', limit: 2 }, context),
    ).toMatchObject({
      query: 'local',
    });
    expect(
      await registry.execute('web.fetch', { url: 'https://example.com' }, context),
    ).toMatchObject({
      content: 'page',
    });
    expect(
      await registry.execute('browser.open', { url: 'https://example.com' }, context),
    ).toMatchObject({
      title: 'page',
    });

    const stored = await registry.execute('memory.store', { content: 'remember this' }, context);
    expect(stored).toMatchObject({ stored: true });
    expect(await registry.execute('memory.search', { query: 'vision' }, context)).toMatchObject({
      mode: 'semantic',
    });
    expect(await registry.execute('memory.forget', { id: 'memory-1' }, context)).toEqual({
      id: 'memory-1',
      deleted: true,
    });
    expect(await registry.execute('run.history', { limit: 5 }, context)).toEqual({
      threadId: 'thread-1',
      runs: [
        {
          id: 'run-1',
          status: 'failed',
          provider: 'codex',
          model: 'gpt-test',
          input: 'review the code',
          output: 'Run tool-call limit exceeded',
          createdAt: 2,
          updatedAt: 3,
        },
      ],
    });

    expect(
      await registry.execute(
        'schedule.create',
        {
          name: 'test',
          type: 'manual',
          expression: '',
          agentInput: 'run',
        },
        context,
      ),
    ).toMatchObject({ id: 'schedule-1' });
    expect(await registry.execute('schedule.list', {}, context)).toEqual({
      schedules: [{ id: 'schedule-1' }],
    });
    expect(
      await registry.execute('schedule.update', { id: 'schedule-1', name: 'updated' }, context),
    ).toMatchObject({ name: 'updated' });
    for (const name of ['schedule.pause', 'schedule.resume', 'schedule.trigger'] as const)
      expect(await registry.execute(name, { id: 'schedule-1' }, context)).toEqual({
        ok: true,
        id: 'schedule-1',
      });
    expect(
      await registry.execute('task.create', { agentInput: 'background' }, context),
    ).toMatchObject({ id: 'task-1' });
    expect(await registry.execute('task.list', {}, context)).toEqual({
      tasks: [{ id: 'task-1', status: 'queued' }],
    });
    expect(await registry.execute('task.cancel', { id: 'task-1' }, context)).toEqual({
      ok: true,
      id: 'task-1',
    });

    expect(await registry.execute('provider.list', {}, context)).toMatchObject({
      active: { name: 'ollama' },
    });
    expect(await registry.execute('provider.status', {}, context)).toMatchObject({
      active: { name: 'ollama' },
    });
    expect(
      await registry.execute('provider.switch', { provider: 'ollama', model: 'next' }, context),
    ).toEqual({
      active: { name: 'ollama', model: 'next' },
      persisted: true,
    });
    expect(await registry.execute('mcp.status', {}, context)).toMatchObject({
      servers: ['computer'],
    });
    expect(await registry.execute('mcp.discover', {}, context)).toEqual([
      { name: 'mcp.computer.capture' },
    ]);
    expect(await registry.execute('computer.status', {}, context)).toMatchObject({ enabled: true });
    expect(await registry.execute('computer.use', { action: 'capture' }, context)).toEqual({
      action: 'capture',
    });
    expect(
      await registry.execute('mcp.execute', { name: 'mcp.computer.capture' }, context),
    ).toEqual({ name: 'mcp.computer.capture' });
    expect(await registry.execute('media.inspect', { path: 'note.txt' }, context)).toMatchObject({
      kind: 'text',
    });
    expect(await registry.execute('agent.list', {}, context)).toEqual({ agents: ['local-agent'] });
    expect(
      await registry.execute('agent.dispatch', { agent: 'local-agent', prompt: 'hello' }, context),
    ).toMatchObject({ ok: true });
    expect(dependencies.calls).toEqual([
      'pause:schedule-1',
      'resume:schedule-1',
      'trigger:schedule-1',
      'cancel:task-1',
    ]);
  });

  it('filters schemas and rejects missing capabilities, malformed input, and unknown tools', async () => {
    const root = await makeRoot();
    const dependencies = services();
    const registry = new ToolRegistry(
      root,
      dependencies.search as never,
      { browserEnabled: false },
      dependencies as never,
    );
    const readOnly: PermissionContext = {
      approved: new Set(['read']),
      capabilities: { filesystem: true },
    };
    expect(registry.schemas(readOnly).some((tool) => tool.name === 'workspace.write')).toBe(false);
    expect(registry.schemas().some((tool) => tool.name === 'browser.open')).toBe(false);
    await expect(
      registry.execute('web.search', { query: 'blocked' }, { root, permissions: readOnly }),
    ).rejects.toThrow('Network capability required');
    await expect(
      registry.execute('workspace.read', { path: '' }, { root, permissions: readOnly }),
    ).rejects.toThrow();
    await expect(
      registry.execute('run.history', {}, { root, permissions: readOnly }),
    ).rejects.toThrow('Current thread is unavailable');
    await expect(
      registry.execute(
        'workspace.write',
        { path: 'x', content: 'x' },
        { root, permissions: readOnly },
      ),
    ).rejects.toThrow('Permission required: write');
    await expect(
      registry.execute('does.not.exist', {}, { root, permissions: readOnly }),
    ).rejects.toThrow('Unknown tool');
  });

  it('uses lexical memory fallback and reports embedding failures truthfully', async () => {
    const root = await makeRoot();
    const dependencies = services();
    const failingProviders = {
      ...dependencies.providers,
      get: () => ({
        embed: async () => {
          throw new Error('Ollama unavailable');
        },
      }),
    };
    const registry = new ToolRegistry(root, undefined, {}, {
      ...dependencies,
      providers: failingProviders,
    } as never);
    const context = { root, permissions: allPermissions };
    expect(
      await registry.execute('memory.store', { content: 'lexical fact' }, context),
    ).toMatchObject({
      stored: true,
      hasEmbedding: false,
      warning: expect.stringContaining('Ollama unavailable'),
    });
    expect(await registry.execute('memory.search', { query: 'Ollama' }, context)).toMatchObject({
      mode: 'lexical',
      warning: expect.stringContaining('Ollama unavailable'),
    });
  });

  it('enforces GitHub capabilities and parses bounded auth and repository results', async () => {
    const root = await makeRoot();
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    const gh = join(bin, 'gh');
    const modeFile = join(root, 'fake-gh-mode');
    await writeFile(
      gh,
      `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
let mode = 'ok';
try { mode = readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim() || 'ok'; }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
if (mode === 'fail') { process.stderr.write('gh unavailable'); process.exit(1); }
if (process.argv.includes('auth')) process.stdout.write('account tylerdotai (github.com)\\n');
else if (process.argv.includes('--jq')) process.stdout.write('3\\n');
else if (mode === 'object') process.stdout.write('{"unexpected":true}');
else process.stdout.write('[{"nameWithOwner":"tylerdotai/example"}]');
`,
    );
    await chmod(gh, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    const dependencies = services();
    const registry = new ToolRegistry(root, undefined, {}, dependencies as never);
    const context = { root, permissions: allPermissions, timeoutMs: 5_000 };
    const noNetwork: ToolContext = {
      root,
      permissions: { approved: new Set(['execute']), capabilities: { subprocess: true } },
    };
    const noSubprocess: ToolContext = {
      root,
      permissions: { approved: new Set(['execute']), capabilities: { network: true } },
    };
    try {
      await expect(registry.execute('github.auth', {}, noNetwork)).rejects.toThrow(
        'Network capability required',
      );
      await expect(registry.execute('github.auth', {}, noSubprocess)).rejects.toThrow(
        'Subprocess capability required',
      );
      expect(await registry.execute('github.auth', {}, context)).toMatchObject({
        exitCode: 0,
        authenticated: true,
        account: 'tylerdotai',
      });
      expect(
        await registry.execute(
          'github.repo.list',
          { owner: 'tylerdotai', mode: 'count', limit: 3 },
          context,
        ),
      ).toEqual({ exitCode: 0, count: 3, limit: 3 });
      expect(
        await registry.execute('github.repo.list', { mode: 'rows', limit: 1 }, context),
      ).toMatchObject({ exitCode: 0, count: 1 });

      await writeFile(modeFile, 'object');
      await expect(
        registry.execute('github.repo.list', { mode: 'rows', limit: 1 }, context),
      ).resolves.toMatchObject({ error: 'GitHub returned a non-array repository result' });
      await writeFile(modeFile, 'fail');
      await expect(registry.execute('github.auth', {}, context)).resolves.toMatchObject({
        authenticated: false,
        error: 'gh unavailable',
      });
      await expect(
        registry.execute('github.repo.list', { mode: 'count', limit: 1 }, context),
      ).resolves.toMatchObject({ error: 'gh unavailable' });
    } finally {
      if (previousPath === undefined) process.env.PATH = undefined;
      else process.env.PATH = previousPath;
    }

    const noEmbeddingProvider = new ToolRegistry(root, undefined, {}, {
      ...dependencies,
      providers: undefined,
    } as never);
    expect(
      await noEmbeddingProvider.execute('memory.search', { query: 'vision' }, context),
    ).toMatchObject({
      mode: 'lexical',
    });
  });
});
