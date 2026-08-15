import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PermissionContext } from '../src/security/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';
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
    deleteMemory: (id: string) => id === 'memory-1',
  };
  const search = {
    search: async (query: string, limit: number) => ({ query, limit, results: ['result'] }),
    fetch: async (url: string) => ({ url, content: 'page' }),
    open: async (url: string) => ({ url, title: 'page' }),
  };
  return { store, scheduler, providers, mcp, media, agents, search, calls };
}

describe('model-facing tool registry contracts', () => {
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
    const context = { root, permissions: allPermissions, timeoutMs: 5_000 };

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
});
