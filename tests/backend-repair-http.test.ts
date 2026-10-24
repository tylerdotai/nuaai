import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { createToken } from '../src/gateway/token.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { DeterministicProvider } from '../src/providers/test.js';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { type GatewayServices, startServer } from '../src/server.js';
import { ToolRegistry } from '../src/tools/registry.js';

it('preserves authenticated flat run acceptance and forwards bounded retry identity without duplicate messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backend-http-'));
  const store = new DatabaseStore(openAppDatabase(root));
  const provider = new DeterministicProvider();
  const providers = {
    get: () => provider,
    active: () => ({ name: provider.name, model: provider.model }),
    list: () => [provider.name],
  } as never;
  const runtime = new AgentRuntime({
    root,
    config: defaultRuntimeConfig(root),
    store,
    providers,
    tools: new ToolRegistry(root),
  });
  const { thread } = runtime.createSession('HTTP retry');
  const secret = 'backend-repair-http-fixture-secret-long-enough';
  const token = createToken({ sub: 'fixture', exp: Math.floor(Date.now() / 1000) + 300 }, secret);
  const server = await startServer({
    root,
    host: '127.0.0.1',
    port: 0,
    authSecret: secret,
    runtime,
    store,
    providers,
    runPermissions: permissionContextForProfile('read-only'),
    scheduler: {},
    skills: {},
    plugins: {},
    secrets: {},
  } as unknown as GatewayServices);
  const post = (body: unknown, authenticated = true) =>
    fetch(`http://127.0.0.1:${server.port}/api/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const body = {
      threadId: thread.id,
      input: 'Hello',
      idempotencyKey: '  client-key-preserved  ',
    };
    expect((await post(body, false)).status).toBe(401);
    const firstResponse = await post(body);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.id).toEqual(expect.any(String));
    expect(first.correlationId).toBe(body.idempotencyKey);
    const second = await (await post(body)).json();
    expect(second.id).toBe(first.id);
    await runtime.waitForRun(first.id);
    expect(
      store
        .listMessages(thread.id)
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual(['Hello']);
    expect((await post({ ...body, input: 'Different' })).status).toBe(400);
    for (const key of ['', '   ', 4, 'x'.repeat(257), null])
      expect((await post({ ...body, idempotencyKey: key })).status).toBe(400);
    expect(store.getRun(first.id)?.correlationId).toBe(body.idempotencyKey);
  } finally {
    await runtime.shutdown();
    await server.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
