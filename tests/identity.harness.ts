import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { type RuntimeConfig, defaultRuntimeConfig } from '../src/config/index.js';
import { type DaemonHandle, startDaemon } from '../src/daemon.js';
import { DeterministicProvider } from '../src/providers/test.js';
import type { ProviderRequest } from '../src/providers/types.js';

export async function identityHarness(
  onRequest?: (request: ProviderRequest) => Promise<void>,
  configure?: (config: RuntimeConfig) => void,
) {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-identity-'));
  const project = join(root, 'project');
  await mkdir(join(root, '.nuaai'), { recursive: true });
  await mkdir(project);
  const config = defaultRuntimeConfig(root);
  config.port = await new Promise<number>((resolve, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') {
        reservation.close();
        reject(new Error('No isolated daemon port'));
        return;
      }
      reservation.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
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
  let daemon: DaemonHandle = await startDaemon(root);
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
      daemon = await startDaemon(root);
    },
    close: async () => {
      await daemon.stop();
      implementation.mockRestore();
      vi.unstubAllEnvs();
      for (const [name, original] of originalSignals)
        for (const listener of process.listeners(name))
          if (!original.includes(listener)) process.removeListener(name, listener);
    },
  };
}
