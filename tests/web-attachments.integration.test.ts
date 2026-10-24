import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { createToken } from '../src/gateway/token.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import type { ProviderRequest } from '../src/providers/types.js';
import { type GatewayServices, startServer } from '../src/server.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { initWorkspace } from '../src/workspace/fs.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

it('delivers actual attached text and image bytes through HTTP and runtime to the provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-attachments-'));
  await initWorkspace(root);
  const store = new DatabaseStore(openAppDatabase(root));
  cleanup.push(() => store.close());
  let observed: ProviderRequest | undefined;
  const provider = {
    name: 'attachment-test',
    model: 'test',
    async *stream(request: ProviderRequest) {
      observed = request;
      yield { type: 'done' as const, text: 'Received the attached source material.' };
    },
    health: async () => ({ name: 'attachment-test', available: true, detail: 'ready' }),
    embed: async () => [],
  };
  const providers = {
    get: () => provider,
    list: () => ['attachment-test'],
    health: async () => [],
  } as never;
  const runtime = new AgentRuntime({
    root,
    config: defaultRuntimeConfig(root),
    store,
    providers,
    tools: new ToolRegistry(root),
  });
  const secret = 'attachment-test-secret-at-least-32-bytes';
  const handle = await startServer({
    root,
    port: 0,
    host: '127.0.0.1',
    authSecret: secret,
    runtime,
    store,
    providers,
  } as unknown as GatewayServices);
  cleanup.push(() => handle.close());
  const { thread } = runtime.createSession('Attachment test', 'attachment-test');
  const image =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
  const headers = {
    authorization: `Bearer ${createToken({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 300 }, secret)}`,
    'content-type': 'application/json',
  };
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      threadId: thread.id,
      input: 'Describe this material. Do not use tools.',
      attachments: [
        {
          name: 'notes.txt',
          data: Buffer.from('The shipment code is BLUEBIRD.').toString('base64'),
        },
        { name: 'pixel.png', data: image },
      ],
    }),
  });
  expect(response.status).toBe(200);
  const run = (await response.json()) as { id: string };
  await expect.poll(() => store.getRun(run.id)?.status).toBe('completed');
  expect(
    observed?.messages.some((message) =>
      message.content.includes('The shipment code is BLUEBIRD.'),
    ),
  ).toBe(true);
  expect(observed?.messages.flatMap((message) => message.images ?? [])).toContainEqual({
    name: 'pixel.png',
    mimeType: 'image/png',
    data: image,
  });
  const invalid = await fetch(`http://127.0.0.1:${handle.port}/api/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      threadId: thread.id,
      input: 'Read this',
      attachments: [{ name: '../../secret.txt', data: 'AA==' }],
    }),
  });
  expect(invalid.status).toBe(400);
});
