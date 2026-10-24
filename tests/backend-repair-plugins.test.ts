import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';

it('discovers permission-filtered trusted plugins and executes only after runtime approval with durable observations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backend-plugin-'));
  const pluginRoot = join(root, '.nuaai', 'plugins', 'fixture');
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, 'manifest.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      apiVersion: '1',
      trusted: true,
      capabilities: ['filesystem'],
    }),
  );
  await writeFile(
    join(pluginRoot, 'index.mjs'),
    "import { writeFile } from 'node:fs/promises'; export async function execute(request) { await writeFile('effect.txt', request.input.text); return { observed: request.input.text }; }",
  );
  const store = new DatabaseStore(openAppDatabase(root));
  const plugins = new PluginRegistry(root, store);
  await plugins.load();
  const tools = new ToolRegistry(root, undefined, {}, { plugins });
  const operator = permissionContextForProfile('operator');
  const readOnly = permissionContextForProfile('read-only');
  const provider: ProviderAdapter = {
    name: 'fixture',
    model: 'fixture',
    async *stream(request) {
      if (!request.messages.some((message) => message.role === 'tool')) {
        expect(request.tools?.some((tool) => tool.name === 'plugin.execute')).toBe(true);
        yield {
          type: 'tool_call',
          id: 'plugin-call',
          name: 'plugin.execute',
          arguments: { name: 'fixture', input: { text: 'PLUGIN_OBSERVED' } },
        };
        yield { type: 'done', text: '' };
      } else yield { type: 'done', text: 'Fixture completed.' };
    },
    async embed() {
      return [];
    },
    async health() {
      return { name: 'fixture', available: true, detail: 'fixture' };
    },
  };
  const providers = {
    get: () => provider,
    list: () => [provider.name],
    active: () => ({ name: provider.name, model: provider.model }),
  } as never;
  const runtime = new AgentRuntime({
    root,
    config: defaultRuntimeConfig(root),
    store,
    providers,
    tools,
    resolvePermissions: () => operator,
  });
  try {
    expect(tools.schemas(readOnly).map((tool) => tool.name)).not.toContain('plugin.execute');
    expect(await tools.execute('plugin.list', {}, { root, permissions: readOnly })).toEqual({
      plugins: [],
    });
    expect(await tools.execute('plugin.list', {}, { root, permissions: operator })).toEqual({
      plugins: [expect.objectContaining({ name: 'fixture' })],
    });
    await expect(
      tools.execute(
        'plugin.execute',
        { name: 'fixture', input: {} },
        { root, permissions: { approved: new Set(['execute']), capabilities: {} } },
      ),
    ).rejects.toThrow(/capability/i);
    const { thread } = runtime.createSession('Plugin run');
    expect(() =>
      tools.previewAdmission(
        'plugin.execute',
        { name: 'fixture', input: {} },
        {
          root,
          permissions: { approved: new Set(['execute']), capabilities: { filesystem: true } },
        },
      ),
    ).toThrow(/subprocess/);
    const run = runtime.startRun({
      threadId: thread.id,
      input: 'Fixture task',
      permissions: operator,
      permissionSource: 'web',
    });
    let approval = runtime.listApprovals('pending')[0];
    for (let n = 0; !approval && n < 200; n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      approval = runtime.listApprovals('pending')[0];
    }
    expect(approval?.toolName).toBe('plugin.execute');
    await expect(access(join(pluginRoot, 'effect.txt'))).rejects.toThrow();
    if (!approval) throw new Error('Expected pending plugin approval');
    runtime.approveApproval(approval.id, approval.payloadHash);
    expect((await runtime.waitForRun(run.id)).status).toBe('completed');
    expect(await readFile(join(pluginRoot, 'effect.txt'), 'utf8')).toBe('PLUGIN_OBSERVED');
    expect(
      store
        .listMessages(thread.id)
        .filter((message) => message.role === 'tool')
        .map((message) => message.content)
        .join(''),
    ).toContain('PLUGIN_OBSERVED');
    expect(store.listEventsForThread(thread.id, 0, 200).events).toContainEqual(
      expect.objectContaining({ type: 'tool.completed', runId: run.id }),
    );
    plugins.disable('fixture');
    await expect(
      tools.execute(
        'plugin.execute',
        { name: 'fixture', input: {} },
        { root, permissions: operator },
      ),
    ).rejects.toThrow(/disabled/);
  } finally {
    await runtime.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
