import { readFile } from 'node:fs/promises';
import { Server } from 'node:net';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import * as gateway from '../src/server.js';
import { identityHarness } from './identity.harness.js';

it('atomically binds the real daemon to an ephemeral loopback port on start and restart', async () => {
  const startServer = gateway.startServer;
  const listen = vi.spyOn(Server.prototype, 'listen');
  let harness: Awaited<ReturnType<typeof identityHarness>> | undefined;
  try {
    harness = await identityHarness();
    expect(gateway.startServer).toBe(startServer);
    expect(listen.mock.calls).toHaveLength(1);
    expect(listen.mock.calls[0]).toEqual([0, '127.0.0.1', expect.any(Function)]);
    expect(harness.daemon.gateway.port).toBeGreaterThan(0);
    const root = harness.root;
    const port = async () =>
      JSON.parse(await readFile(join(root, '.nuaai/config.json'), 'utf8')).port;
    expect(await port()).toBe(harness.daemon.gateway.port);
    const url = () => `http://127.0.0.1:${harness?.daemon.gateway.port}/api/status`;
    expect((await fetch(url())).status).toBe(401);
    expect((await harness.api('/api/status')).status).toBe(200);

    await harness.restart();
    expect(gateway.startServer).toBe(startServer);
    expect(listen.mock.calls).toHaveLength(2);
    expect(listen.mock.calls[1]).toEqual([0, '127.0.0.1', expect.any(Function)]);
    expect(harness.daemon.gateway.port).toBeGreaterThan(0);
    expect(await port()).toBe(harness.daemon.gateway.port);
    expect((await fetch(url())).status).toBe(401);
    expect((await harness.api('/api/status')).status).toBe(200);
  } finally {
    await harness?.close();
    listen.mockRestore();
  }
});

it('restores fixture wrappers after a failed daemon bind before another fixture starts', async () => {
  const startServer = gateway.startServer;
  const stream = DeterministicProvider.prototype.stream;
  const listen = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (
    this: Server,
  ) {
    queueMicrotask(() => this.emit('error', new Error('Fixture startup failure')));
    return this;
  });
  try {
    await expect(identityHarness()).rejects.toThrow('Fixture startup failure');
    expect(gateway.startServer).toBe(startServer);
    expect(DeterministicProvider.prototype.stream).toBe(stream);
    const harness = await identityHarness();
    try {
      expect(gateway.startServer).toBe(startServer);
      expect((await harness.api('/api/status')).status).toBe(200);
    } finally {
      await harness.close();
    }
  } finally {
    listen.mockRestore();
  }
});
