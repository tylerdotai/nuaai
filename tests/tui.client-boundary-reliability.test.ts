import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { Scheduler } from '../src/core/scheduler.js';
import { createToken } from '../src/gateway/token.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SecretsManager } from '../src/security/secrets.js';
import { startServer } from '../src/server.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Tui } from '../src/ui/tui.js';

it('T06 real Ink → authenticated server → runtime → SQLite accepts one run when the acceptance response is lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-client-real-boundary-'));
  vi.stubEnv('NUAAI_TEST_MODE', '1');
  const store = new DatabaseStore(openAppDatabase(root));
  const config = defaultRuntimeConfig(root);
  config.provider.name = 'deterministic';
  config.provider.model = 'local-test';
  const providers = new ProviderRegistry({
    root,
    providerName: 'deterministic',
    model: 'local-test',
    baseUrl: 'http://127.0.0.1:1',
    embeddingModel: 'local-test',
    timeoutMs: 1000,
    ollamaEnabled: false,
    codexEnabled: false,
  });
  const runtime = new AgentRuntime({
    root,
    config,
    store,
    providers,
    tools: new ToolRegistry(root, undefined, { browserEnabled: false, searchEnabled: false }),
  });
  const created = runtime.createSession('Real isolated boundary', 'tui:boundary');
  const secret = 'isolated-client-boundary-test-secret-at-least-32';
  const token = createToken(
    { sub: 'client-fixture', exp: Math.floor(Date.now() / 1000) + 60 },
    secret,
  );
  const server = await startServer({
    root,
    host: '127.0.0.1',
    port: 0,
    authSecret: secret,
    runtime,
    store,
    providers,
    scheduler: new Scheduler(
      store,
      () => {},
      async () => {},
    ),
    skills: new SkillRegistry(),
    plugins: new PluginRegistry(root, store),
    secrets: new SecretsManager(store, root),
  });
  const nativeFetch = globalThis.fetch;
  let dropped = false;
  const keys: string[] = [];
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const response = await nativeFetch(url, options);
    if (String(url).endsWith('/api/runs') && options?.method === 'POST') {
      keys.push(JSON.parse(String(options.body)).idempotencyKey);
      if (!dropped) {
        dropped = true;
        // The real route has accepted and SQLite has committed before the
        // simulated transport loses its response. No provider/network stubs.
        await response.arrayBuffer();
        throw new TypeError('fixture lost accepted response');
      }
    }
    return response;
  });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 32 });
  let frame = '';
  stdout.on('data', (chunk) => {
    frame = String(chunk);
  });
  const app = render(
    createElement(Tui, { root, baseUrl: `http://127.0.0.1:${server.port}`, token }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  try {
    await expect.poll(() => frame).toContain('Connected');
    await expect.poll(() => frame).toContain('deterministic/local-test');
    stdin.write('fixture greeting');
    await expect.poll(() => frame).toContain('fixture greeting');
    stdin.write('\r');
    await expect.poll(() => frame).toContain('Run acceptance uncertain');
    await expect.poll(() => store.listRuns(created.thread.id)[0]?.status).toBe('completed');
    expect(frame).toContain('› fixture greeting');
    stdin.write('\r');
    await expect.poll(() => keys.length).toBe(2);
    await expect.poll(() => frame).toContain('Run accepted');
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(store.listRuns(created.thread.id)).toHaveLength(1);
    expect(
      store
        .listMessages(created.thread.id)
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual(['fixture greeting']);
    expect(frame).not.toContain('› fixture greeting');
    await expect.poll(() => frame).toContain('NUAAI deterministic test response');
  } finally {
    app.unmount();
    app.cleanup();
    fetchSpy.mockRestore();
    await server.close();
    await providers.close();
    store.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
