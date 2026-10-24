import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { RunArtifactRegistry } from '../src/artifacts/registry.js';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { Scheduler } from '../src/core/scheduler.js';
import { createToken } from '../src/gateway/token.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import type { ProviderRequest } from '../src/providers/types.js';
import { SecretsManager } from '../src/security/secrets.js';
import { type GatewayServices, startServer } from '../src/server.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Tui } from '../src/ui/tui.js';
import { initWorkspace } from '../src/workspace/fs.js';

it('carries attached bytes from real TUI keys through authenticated HTTP/runtime and saves the resulting approved artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-tui-runtime-'));
  await initWorkspace(root);
  const store = new DatabaseStore(openAppDatabase(root));
  const artifacts = new RunArtifactRegistry(root, store);
  const observed: ProviderRequest[] = [];
  const provider = {
    name: 'fixture',
    model: 'fixture',
    async *stream(request: ProviderRequest) {
      observed.push(request);
      if (!request.messages.some((message) => message.role === 'tool')) {
        yield {
          type: 'tool_call' as const,
          id: 'write-artifact',
          name: 'workspace.write',
          arguments: { path: 'result.txt', content: 'VERIFIED_ARTIFACT_BYTES Ω' },
        };
      } else if (!request.messages.some((message) => message.toolName === 'workspace.read')) {
        yield {
          type: 'tool_call' as const,
          id: 'read-artifact',
          name: 'workspace.read',
          arguments: { path: 'result.txt' },
        };
      } else
        yield {
          type: 'done' as const,
          text: 'The attached source was used.\n```txt\nVERIFIED_ARTIFACT_BYTES Ω\n```',
        };
    },
    health: async () => ({
      name: 'fixture',
      available: true,
      detail: 'controlled provider',
      models: ['fixture'],
    }),
    embed: async () => [],
  };
  const providers = {
    catalog: async () => ({
      active: { name: 'fixture', model: 'fixture' },
      providers: [await provider.health()],
    }),
    get: () => provider,
    list: () => ['fixture'],
    health: async () => [await provider.health()],
    active: () => ({ name: 'fixture', model: 'fixture' }),
  } as never;
  const config = defaultRuntimeConfig(root);
  config.provider.name = 'fixture';
  config.provider.model = 'fixture';
  const runtime = new AgentRuntime({
    root,
    config,
    store,
    providers,
    artifacts,
    tools: new ToolRegistry(root),
  });
  const secret = 'isolated-test-auth-secret-at-least-32-bytes';
  const server = await startServer({
    root,
    port: 0,
    host: '127.0.0.1',
    authSecret: secret,
    runPermissionProfile: 'operator',
    runtime,
    store,
    providers,
    artifacts,
    scheduler: new Scheduler(
      store,
      () => {},
      async () => {},
    ),
    skills: new SkillRegistry(),
    plugins: new PluginRegistry(root, store),
    secrets: new SecretsManager(store, root),
  } as unknown as GatewayServices);
  const { thread } = runtime.createSession('Runtime workflow', 'tui:runtime-workflow');
  const source = join(root, 'source.txt');
  await writeFile(source, 'ATTACHED_SOURCE Ω');
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 36 });
  let output = '';
  stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  const frame = () => {
    const starts = [
      ...output.matchAll(/\n NUAAI\n (?:Connected|Connecting|Loading|Disconnected)/gu),
    ];
    return output.slice(starts.at(-1)?.index ?? 0);
  };
  const app = render(
    createElement(Tui, {
      root,
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: createToken({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 300 }, secret),
    }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  const send = async (bytes: string, expected: string) => {
    await expect.poll(() => !frame().includes('Applying…'), { timeout: 5000 }).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = output.length;
    stdin.write(bytes);
    await expect
      .poll(() => (output.length > before ? frame() : ''), { timeout: 5000 })
      .toContain(expected);
  };
  try {
    await expect.poll(frame).toContain('fixture/fixture');
    await send(`/attach ${source} `, '/attach');
    await send('\r', 'Attached source.txt');
    await send(
      'Write result.txt containing VERIFIED_ARTIFACT_BYTES Ω using workspace.write.',
      'Write result.txt',
    );
    await send('\r', 'Approval required');
    expect(
      observed[0].messages.some((message) => message.content.includes('ATTACHED_SOURCE Ω')),
    ).toBe(true);
    await send('\u0019', 'Action approved');
    await expect
      .poll(
        async () => {
          try {
            return await readFile(join(root, 'result.txt'), 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
            throw error;
          }
        },
        { timeout: 5000 },
      )
      .toBe('VERIFIED_ARTIFACT_BYTES Ω');
    await expect.poll(() => store.getLatestRun(thread.id)?.status).toBe('completed');
    await expect.poll(frame).toContain('Artifact: result.txt');
    await expect.poll(frame).not.toContain('Applying…');
    await send('\u001bo', 'Conversation outputs');
    await send('Artifact · result.txt', 'Search: Artifact · result.txt');
    await expect.poll(frame).toContain('Artifact · result.txt');
    await send('\r', 'Artifact actions');
    await send('\r', 'Artifact saved:');
    const saved = (await readdir(join(root, '.nuaai/exports'))).find((name) =>
      name.endsWith('result.txt'),
    );
    if (!saved) throw new Error('Missing saved artifact');
    expect(await readFile(join(root, '.nuaai/exports', saved), 'utf8')).toBe(
      'VERIFIED_ARTIFACT_BYTES Ω',
    );
  } finally {
    app.unmount();
    app.cleanup();
    await runtime.shutdown();
    await server.close();
    store.close();
  }
}, 15_000);
