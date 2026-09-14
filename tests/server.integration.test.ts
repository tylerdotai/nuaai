import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { createToken, validateToken } from '../src/gateway/token.js';
import { type GatewayServices, startServer } from '../src/server.js';

const secret = 'server-test-secret-with-at-least-32-bytes';
const token = createToken({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 300 }, secret);
const browserPairingToken = createToken(
  {
    sub: 'browser-pairing',
    purpose: 'browser-pairing',
    exp: Math.floor(Date.now() / 1000) + 300,
  },
  secret,
);
const handles: Array<{ close(): Promise<void> }> = [];

function services(events: Array<Record<string, unknown>> = []): GatewayServices {
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
  const eventPage = (values: Array<Record<string, unknown>>, after = 0, limit = 1_000) => {
    const filtered = values.filter((event) => Number(event.id ?? 0) > after);
    const page = filtered.slice(0, limit);
    return {
      events: page,
      nextCursor: Number(page.at(-1)?.id ?? after),
      hasMore: filtered.length > page.length,
    };
  };
  return {
    root: process.cwd(),
    port: 0,
    host: '127.0.0.1',
    authSecret: secret,
    browserCookiePath: '/nuaai',
    webRoot: process.cwd(),
    runtime: runtime as never,
    store: {
      listEvents: () => events,
      listEventsForSession: (sessionId: string, after: number, limit: number) =>
        eventPage(
          events.filter((event) => event.sessionId === sessionId),
          after,
          limit,
        ),
      listEventsForThread: (threadId: string, after: number, limit: number) =>
        eventPage(
          events.filter((event) => event.threadId === threadId),
          after,
          limit,
        ),
      listRecentEventsForRun: (runId: string, limit: number) =>
        events.filter((event) => event.runId === runId).slice(-limit),
      listMessages: () => [],
      listMessagePage: () => ({ messages: [], nextCursor: 0, hasMore: false }),
      listThreadArtifacts: () => [],
      getRun: () => undefined,
      getLatestRun: () => undefined,
      listActiveRunsForThread: () => [],
      getThread: () => undefined,
    } as never,
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
    const response = await fetch(`${baseUrl}/nuaai/api/status`);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Pair this device to continue.',
      code: 'AUTH_REQUIRED',
    });
    await expect(
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/nuaai/ws`);
        socket.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
        socket.once('error', reject);
      }),
    ).resolves.toEqual({ code: 1008, reason: 'AUTH_REQUIRED' });
  });

  it('reports a valid but expired browser credential without accepting it', async () => {
    const handle = await startServer(services());
    handles.push(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const expired = createToken({ sub: 'expired-browser', exp: 1 }, secret, 0);

    const response = await fetch(`${baseUrl}/nuaai/api/status`, {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Session expired — pair this device again.',
      code: 'AUTH_EXPIRED',
    });
    await expect(
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/nuaai/ws?token=${expired}`);
        socket.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
        socket.once('error', reject);
      }),
    ).resolves.toEqual({ code: 1008, reason: 'AUTH_EXPIRED' });
  });

  it('requires explicit browser pairing before issuing an authenticated cookie', async () => {
    const handle = await startServer(services());
    handles.push(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const shell = await fetch(`${baseUrl}/nuaai/`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get('set-cookie')).toBeNull();

    const refused = await fetch(`${baseUrl}/nuaai/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'invalid' }),
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('set-cookie')).toBeNull();

    const runtimeRefused = await fetch(`${baseUrl}/nuaai/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(runtimeRefused.status).toBe(401);
    expect(runtimeRefused.headers.get('set-cookie')).toBeNull();

    const pairingApiResponse = await fetch(`${baseUrl}/nuaai/api/status`, {
      headers: { authorization: `Bearer ${browserPairingToken}` },
    });
    expect(pairingApiResponse.status).toBe(401);
    const pairingWebSocketAccepted = await new Promise<boolean>((resolve, reject) => {
      const socket = new WebSocket(
        `${baseUrl.replace('http', 'ws')}/nuaai/ws?token=${browserPairingToken}`,
      );
      socket.once('message', () => {
        resolve(true);
        socket.close();
      });
      socket.once('close', (code) => {
        if (code === 1008) resolve(false);
      });
      socket.once('error', reject);
    });
    expect(pairingWebSocketAccepted).toBe(false);

    const paired = await fetch(`${baseUrl}/nuaai/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ token: browserPairingToken }),
    });
    expect(paired.status).toBe(200);
    const cookie = paired.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('nuaai_token=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/nuaai');
    await expect(
      fetch(`${baseUrl}/nuaai/api/status`, { headers: { cookie } }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('scopes paired cookies to the actual root or /nuaai ingress mount', async () => {
    const gateway = services();
    gateway.browserCookiePath = undefined;
    const handle = await startServer(gateway);
    handles.push(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    const pair = (path: string) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nuaai-mount-path': '/spoofed',
        },
        body: JSON.stringify({ token: browserPairingToken }),
      });
    const rootCookie = (await pair('/auth/pair')).headers.get('set-cookie') ?? '';
    const mountedCookie = (await pair('/nuaai/auth/pair')).headers.get('set-cookie') ?? '';

    expect(rootCookie).toContain('Path=/;');
    expect(rootCookie).not.toContain('Path=/spoofed');
    expect(mountedCookie).toContain('Path=/nuaai;');
    expect(mountedCookie).not.toContain('Path=/spoofed');
  });

  it('uses configured mount scope for a proxy-stripped request but not direct local root', async () => {
    const gateway = services();
    gateway.browserCookiePath = '/nuaai';
    const handle = await startServer(gateway);
    handles.push(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const pair = (forwarded: boolean) =>
      fetch(`${baseUrl}/auth/pair`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(forwarded ? { 'x-forwarded-proto': 'https' } : {}),
        },
        body: JSON.stringify({ token: browserPairingToken }),
      });

    const directCookie = (await pair(false)).headers.get('set-cookie') ?? '';
    const proxiedCookie = (await pair(true)).headers.get('set-cookie') ?? '';
    expect(directCookie).toContain('Path=/;');
    expect(proxiedCookie).toContain('Path=/nuaai;');
  });

  it('exchanges a nearly expired pairing token for a fresh browser-session token', async () => {
    const now = 1_800_000_000_000;
    const gateway = services();
    gateway.now = () => now;
    const pairingToken = createToken(
      {
        sub: 'browser-pairing',
        purpose: 'browser-pairing',
        exp: Math.floor(now / 1_000) + 5,
      },
      secret,
      now,
    );
    const handle = await startServer(gateway);
    handles.push(handle);

    const response = await fetch(`http://127.0.0.1:${handle.port}/nuaai/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ token: pairingToken }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    const sessionToken = /nuaai_token=([^;]+)/.exec(cookie)?.[1];
    expect(sessionToken).toBeTruthy();
    expect(sessionToken).not.toBe(pairingToken);
    expect(validateToken(sessionToken ?? '', secret, now)).toMatchObject({
      sub: 'browser-session',
      purpose: 'browser-session',
      exp: Math.floor(now / 1_000) + 2_592_000,
    });
  });

  it('rejects cookie paths that could inject additional cookie attributes', async () => {
    const gateway = services();
    gateway.browserCookiePath = '/nuaai; SameSite=None';

    await expect(startServer(gateway)).rejects.toThrow(
      'Browser cookie path must be an absolute path without whitespace or semicolons',
    );
  });

  it('runs authenticated Web requests with the configured operator permission profile', async () => {
    const gateway = services();
    const startRun = vi.fn((_request: unknown) => ({ id: 'operator-run' }));
    gateway.runtime.startRun = startRun as never;
    gateway.runPermissionProfile = 'operator';
    gateway.runPermissions = {
      approved: new Set(['read', 'write', 'execute']),
      capabilities: { filesystem: true, subprocess: true, network: true },
    };
    const handle = await startServer(gateway);
    handles.push(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { authorization: ['Bearer', token].join(' '), 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-1', input: 'do the work' }),
    });

    expect(response.status).toBe(200);
    expect(startRun).toHaveBeenCalledOnce();
    const request = startRun.mock.calls[0]?.[0] as {
      permissions: { approved: Set<string>; capabilities: Record<string, boolean> };
    };
    expect([...request.permissions.approved]).toEqual(['read', 'write', 'execute']);
    expect(request.permissions.capabilities).toEqual({
      filesystem: true,
      subprocess: true,
      network: true,
    });
    const status = await fetch(`${baseUrl}/api/status`, {
      headers: { authorization: ['Bearer', token].join(' ') },
    });
    await expect(status.json()).resolves.toMatchObject({ webPermissionProfile: 'operator' });
  });

  it('rejects request bodies larger than one mebibyte before routing', async () => {
    const handle = await startServer(services());
    handles.push(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const response = await fetch(`${baseUrl}/nuaai/api/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(1_048_577) }),
    });

    expect(response.status).toBe(413);
  });

  it('replays only events from the subscribed session over WebSocket', async () => {
    const events = [
      { id: 1, type: 'message.created', sessionId: 'session-a', payload: { text: 'a' } },
      { id: 2, type: 'message.created', sessionId: 'session-b', payload: { text: 'b' } },
    ];
    const handle = await startServer(services(events));
    handles.push(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const replay = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const received: Array<Record<string, unknown>> = [];
      const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/nuaai/ws?token=${token}`);
      const timer = setTimeout(() => {
        socket.close();
        resolve(received);
      }, 100);
      socket.on('message', (value) => {
        const message = JSON.parse(String(value)) as Record<string, unknown>;
        if (message.type === 'ready') {
          socket.send(JSON.stringify({ type: 'subscribe', sessionId: 'session-a', after: 0 }));
          return;
        }
        received.push(message);
        if (message.type === 'replay.complete') {
          clearTimeout(timer);
          socket.close();
          resolve(received);
        }
      });
      socket.once('error', reject);
    });

    expect(replay).toEqual([
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({ sessionId: 'session-a' }),
      }),
      { type: 'replay.complete', nextCursor: 1, hasMore: false },
    ]);
  });

  it('paginates HTTP replay after applying the requested session scope', async () => {
    const gateway = services();
    const selected = {
      id: 1_502,
      type: 'run.completed',
      sessionId: 'session-b',
      threadId: 'thread-b',
      runId: 'run-b',
      payload: {},
    };
    const listEventsForSession = vi.fn(() => ({
      events: [selected],
      nextCursor: selected.id,
      hasMore: true,
    }));
    gateway.store = {
      ...gateway.store,
      listEvents: () => {
        throw new Error('global replay must not be queried');
      },
      listEventsForSession,
    } as never;
    const handle = await startServer(gateway);
    handles.push(handle);
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/api/events?sessionId=session-b&after=1500&limit=1`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [selected],
      nextCursor: 1_502,
      hasMore: true,
    });
    expect(listEventsForSession).toHaveBeenCalledWith('session-b', 1_500, 1);
  });

  it('returns the latest run and bounded chronological activity for one thread', async () => {
    const gateway = services();
    const run = {
      id: 'run-a',
      threadId: 'thread-a',
      status: 'running',
      provider: 'codex',
      model: 'gpt-test',
      input: 'inspect',
      output: '',
      cancelRequested: false,
      createdAt: 100,
      updatedAt: 101,
      correlationId: 'correlation-a',
    };
    const events = [
      { id: 40, type: 'run.started', threadId: 'thread-a', runId: 'run-a', payload: {} },
      { id: 41, type: 'tool.started', threadId: 'thread-a', runId: 'run-a', payload: {} },
    ];
    const queued = { ...run, id: 'run-b', status: 'queued', createdAt: 102, updatedAt: 102 };
    const { correlationId: _correlationId, input: _input, ...publicRun } = run;
    gateway.store = {
      ...gateway.store,
      getThread: () => ({ id: 'thread-a', sessionId: 'session-a' }),
      getLatestRun: () => run,
      listActiveRunsForThread: () => [run, queued],
      listRecentEventsForRun: () => [],
      listProjectionEventsForRun: () => events,
      eventHighWaterForSession: () => 99,
    } as never;
    const handle = await startServer(gateway);
    handles.push(handle);
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/threads/thread-a/run-state`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 1,
      threadId: 'thread-a',
      run: publicRun,
      activeRunId: 'run-a',
      queuedRunIds: ['run-b'],
      queuedRuns: [{ id: 'run-b', input: 'inspect', createdAt: 102 }],
      events,
      lastEventId: 99,
    });
  });

  it('serves a versioned structured conversation instead of plain message rows', async () => {
    const gateway = services();
    const run = {
      id: 'run-a',
      threadId: 'thread-a',
      status: 'completed',
      provider: 'codex',
      model: 'gpt-test',
      input: 'inspect',
      output: '## Done',
      cancelRequested: false,
      createdAt: 100,
      updatedAt: 110,
      correlationId: 'private-correlation',
    };
    const listMessagePage = vi.fn(() => ({
      messages: [
        {
          id: 'message-a',
          threadId: 'thread-a',
          role: 'assistant',
          content: '## Done',
          provider: 'codex',
          model: 'gpt-test',
          createdAt: 109,
        },
      ],
      nextCursor: 1,
      hasMore: false,
    }));
    gateway.store = {
      ...gateway.store,
      getThread: () => ({ id: 'thread-a', sessionId: 'session-a' }),
      listMessagePage,
      listThreadArtifacts: () => [
        { messageId: 'message-a', kind: 'run_link', payload: { runId: 'run-a' }, createdAt: 109 },
      ],
      getRun: () => run,
      getLatestRun: () => run,
      listRecentEventsForRun: () => [],
      listProjectionEventsForRun: () => [],
    } as never;
    gateway.runtime.listMessages = () => {
      throw new Error('plain messages must not back the presentation route');
    };
    const handle = await startServer(gateway);
    handles.push(handle);
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/api/threads/thread-a/presentation?before=42&limit=20`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 1,
      threadId: 'thread-a',
      nextCursor: expect.any(Number),
      hasMore: false,
      messages: [
        expect.objectContaining({
          id: 'run:run-a:assistant',
          runId: 'run-a',
          role: 'assistant',
          markdown: '## Done',
          status: 'completed',
        }),
      ],
    });
    expect(listMessagePage).toHaveBeenCalledWith('thread-a', 42, 20);
  });

  it('rejects cancellation when a stale run does not belong to the selected thread', async () => {
    const gateway = services();
    const cancelRun = vi.fn();
    gateway.runtime.cancelRun = cancelRun;
    gateway.store = {
      ...gateway.store,
      getThread: (threadId: string) => ({ id: threadId, sessionId: 'session-a' }),
      getRun: (runId: string) => ({ id: runId, threadId: 'thread-b' }),
    } as never;
    const handle = await startServer(gateway);
    handles.push(handle);
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/api/threads/thread-a/runs/run-b/cancel`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Run does not belong to this thread' });
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it('cancels only an active run owned by the selected thread', async () => {
    const gateway = services();
    const cancelRun = vi.fn();
    let status = 'completed';
    gateway.runtime.cancelRun = cancelRun;
    gateway.store = {
      ...gateway.store,
      getThread: (threadId: string) => ({ id: threadId, sessionId: 'session-a' }),
      getRun: (runId: string) => ({ id: runId, threadId: 'thread-a', status }),
    } as never;
    const handle = await startServer(gateway);
    handles.push(handle);
    const url = `http://127.0.0.1:${handle.port}/api/threads/thread-a/runs/run-a/cancel`;
    const headers = { authorization: `Bearer ${token}` };

    const terminal = await fetch(url, { method: 'POST', headers });
    expect(terminal.status).toBe(409);
    await expect(terminal.json()).resolves.toEqual({ error: 'Run is not active' });
    expect(cancelRun).not.toHaveBeenCalled();

    status = 'running';
    const active = await fetch(url, { method: 'POST', headers });
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toEqual({ ok: true });
    expect(cancelRun).toHaveBeenCalledWith('run-a');
  });
});
