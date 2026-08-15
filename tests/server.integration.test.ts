import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createToken } from '../src/gateway/token.js';
import { type GatewayServices, startServer } from '../src/server.js';

const secret = 'server-test-secret-with-at-least-32-bytes';
const token = createToken({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 300 }, secret);
const handles: Array<{ close(): Promise<void> }> = [];

function services(): GatewayServices {
  const runtime = {
    subscribe: () => () => undefined,
    status: () => ({ activeRuns: 0, sessions: 0, threads: 0 }),
    providerHealth: async () => [],
    listSessions: () => [],
    createSession: () => ({ session: {}, thread: {} }),
    getSession: () => undefined,
    listThreads: () => [],
    listMessages: () => [],
    startRun: () => ({ id: 'run' }),
    resumeRun: () => ({ id: 'run' }),
    cancelRun: () => undefined,
  };
  const empty = {
    list: () => [],
    health: () => [],
    listNames: () => [],
  };
  return {
    root: process.cwd(),
    port: 0,
    host: '127.0.0.1',
    authSecret: secret,
    authToken: token,
    runtime: runtime as never,
    store: { listEvents: () => [], getRun: () => undefined } as never,
    providers: { catalog: async () => ({ providers: [] }) } as never,
    scheduler: { list: () => [], listTasks: () => [] } as never,
    skills: empty as never,
    plugins: empty as never,
    secrets: empty as never,
  };
}

afterEach(async () => {
  while (handles.length) await handles.pop()?.close();
});

describe('authenticated daemon client routes', () => {
  it('serves the PWA API under /nuaai and accepts the authenticated /nuaai/ws route', async () => {
    const handle = await startServer(services());
    handles.push(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const response = await fetch(`${baseUrl}/nuaai/api/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ activeRuns: 0 });

    const ready = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/nuaai/ws?token=${token}`);
      socket.once('message', (value) => {
        socket.close();
        resolve(String(value));
      });
      socket.once('error', reject);
    });
    expect(JSON.parse(ready)).toEqual({ type: 'ready', version: expect.any(String) });
  });

  it('rejects unauthenticated HTTP and WebSocket access', async () => {
    const handle = await startServer(services());
    handles.push(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    await expect(fetch(`${baseUrl}/nuaai/api/status`)).resolves.toMatchObject({ status: 401 });
    await expect(
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/nuaai/ws`);
        socket.once('close', (code) => resolve(code));
        socket.once('error', reject);
      }),
    ).resolves.toBe(1008);
  });
});
