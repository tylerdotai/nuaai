import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { startDaemon } from '../src/daemon.js';
import { DeterministicProvider } from '../src/providers/test.js';

it('wires installed plugin tools into the real isolated daemon and records approved execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backend-daemon-plugin-'));
  const pluginRoot = join(root, '.nuaai', 'plugins', 'daemon-fixture');
  await mkdir(pluginRoot, { recursive: true });
  const config = defaultRuntimeConfig(root);
  await writeFile(
    join(root, '.nuaai', 'config.json'),
    JSON.stringify({
      ...config,
      features: {
        ...config.features,
        matrix: false,
        search: false,
        browser: false,
        ollama: false,
        codex: false,
      },
      mcp: { enabled: false, servers: {} },
    }),
  );
  await writeFile(
    join(pluginRoot, 'manifest.json'),
    JSON.stringify({
      name: 'daemon-fixture',
      version: '1.0.0',
      apiVersion: '1',
      trusted: true,
      capabilities: ['filesystem'],
    }),
  );
  await writeFile(
    join(pluginRoot, 'index.mjs'),
    "import { writeFile } from 'node:fs/promises'; export async function execute() { await writeFile('effect.txt', 'DAEMON_PLUGIN_OBSERVED'); return { observation: 'DAEMON_PLUGIN_OBSERVED' }; }",
  );
  vi.stubEnv('NUAAI_TEST_MODE', '1');
  const stream = vi
    .spyOn(DeterministicProvider.prototype, 'stream')
    .mockImplementation(async function* (request) {
      if (!request.messages.some((message) => message.role === 'tool')) {
        expect(request.tools?.map((tool) => tool.name)).toContain('plugin.execute');
        yield {
          type: 'tool_call',
          id: 'daemon-plugin-call',
          name: 'plugin.execute',
          arguments: { name: 'daemon-fixture', input: {} },
        };
        yield { type: 'done', text: '' };
      } else yield { type: 'done', text: 'Fixture result observed.' };
    });
  const sigint = process.listeners('SIGINT');
  const sigterm = process.listeners('SIGTERM');
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon(root);
    const response = await fetch(`http://127.0.0.1:${daemon.gateway.port}/api/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Daemon fixture' }),
    });
    const { thread } = await response.json();
    const accepted = await fetch(`http://127.0.0.1:${daemon.gateway.port}/api/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: thread.id, input: 'Fixture task' }),
    });
    const run = await accepted.json();
    let approval = daemon.runtime.listApprovals('pending')[0];
    for (let n = 0; !approval && n < 200; n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      approval = daemon.runtime.listApprovals('pending')[0];
    }
    if (!approval) throw new Error('Missing daemon plugin approval');
    expect(approval.toolName).toBe('plugin.execute');
    await expect(access(join(pluginRoot, 'effect.txt'))).rejects.toThrow();
    daemon.runtime.approveApproval(approval.id, approval.payloadHash);
    expect((await daemon.runtime.waitForRun(run.id)).status).toBe('completed');
    expect(await readFile(join(pluginRoot, 'effect.txt'), 'utf8')).toBe('DAEMON_PLUGIN_OBSERVED');
    expect(
      daemon.store
        .listMessages(thread.id)
        .filter((message) => message.role === 'tool')
        .map((message) => message.content)
        .join(''),
    ).toContain('DAEMON_PLUGIN_OBSERVED');
    expect(daemon.store.listEventsForThread(thread.id, 0, 200).events).toContainEqual(
      expect.objectContaining({ type: 'tool.completed', runId: run.id }),
    );
  } finally {
    await daemon?.stop();
    for (const listener of process.listeners('SIGINT'))
      if (!sigint.includes(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM'))
      if (!sigterm.includes(listener)) process.removeListener('SIGTERM', listener);
    stream.mockRestore();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
