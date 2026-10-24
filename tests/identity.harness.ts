import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { type RuntimeConfig, defaultRuntimeConfig } from '../src/config/index.js';
import { type DaemonHandle, startDaemon } from '../src/daemon.js';
import { DeterministicProvider } from '../src/providers/test.js';
import type { ProviderRequest } from '../src/providers/types.js';
import * as gateway from '../src/server.js';

async function startIsolatedDaemon(root: string): Promise<DaemonHandle> {
  // Config still validates a positive production port. Only this fixture's real
  // listener gets port zero, retaining the OS allocation until daemon shutdown.
  const startServer = gateway.startServer;
  const start = vi
    .spyOn(gateway, 'startServer')
    .mockImplementation((services) => startServer({ ...services, port: 0 }));
  let daemon: DaemonHandle;
  try {
    daemon = await startDaemon(root);
  } finally {
    start.mockRestore();
  }
  try {
    // CLI clients discover the listener through this private fixture config.
    // Preserve settings persisted by the daemon (including across restarts).
    const path = join(root, '.nuaai/config.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...config, port: daemon.gateway.port }));
    return daemon;
  } catch (error) {
    await daemon.stop();
    throw error;
  }
}

export async function identityHarness(
  onRequest?: (request: ProviderRequest) => Promise<void>,
  configure?: (config: RuntimeConfig) => void,
) {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-identity-'));
  const project = join(root, 'project');
  await mkdir(join(root, '.nuaai'), { recursive: true });
  await mkdir(project);
  const config = defaultRuntimeConfig(root);
  config.features = {
    ...config.features,
    matrix: false,
    search: false,
    browser: false,
    ollama: false,
    codex: false,
  };
  config.mcp.enabled = false;
  configure?.(config);
  await writeFile(join(root, '.nuaai/config.json'), JSON.stringify(config));
  vi.stubEnv('NUAAI_TEST_MODE', '1');
  const observed: ProviderRequest[] = [];
  const implementation = vi
    .spyOn(DeterministicProvider.prototype, 'stream')
    .mockImplementation(async function* (request) {
      observed.push(request);
      await onRequest?.(request);
      yield { type: 'done' as const, text: 'Identity fixture completed.' };
    });
  const originalSignals = new Map(
    (['SIGINT', 'SIGTERM'] as const).map((name) => [name, process.listeners(name)]),
  );
  const cleanup = () => {
    implementation.mockRestore();
    vi.unstubAllEnvs();
    for (const [name, original] of originalSignals)
      for (const listener of process.listeners(name))
        if (!original.includes(listener)) process.removeListener(name, listener);
  };
  let daemon: DaemonHandle;
  try {
    daemon = await startIsolatedDaemon(root);
  } catch (error) {
    cleanup();
    throw error;
  }
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${daemon.gateway.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    return { status: response.status, body: result };
  };
  const run = async (threadId: string) => {
    const accepted = await api('/api/runs', {
      threadId,
      input: 'Fixture response; do not use tools.',
    });
    expect(accepted.status).toBe(200);
    expect((await daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
    const request = observed.at(-1);
    if (!request) throw new Error('Provider request not observed');
    return request;
  };
  return {
    root,
    project,
    api,
    run,
    observed,
    get daemon() {
      return daemon;
    },
    restart: async () => {
      await daemon.stop();
      daemon = await startIsolatedDaemon(root);
    },
    close: async () => {
      try {
        await daemon.stop();
      } finally {
        cleanup();
      }
    },
  };
}
