import { describe, expect, it } from 'vitest';

import { createToken } from '../src/gateway/token.js';
import { type GatewayServices, createApp } from '../src/server.js';

const secret = 'sse-test-secret-with-at-least-32-bytes-long';
const token = createToken({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 300 }, secret);

function services(events: Array<Record<string, unknown>> = []): GatewayServices {
  const runtime = {
    subscribe: () => () => undefined,
    status: () => ({ activeRuns: 0 }),
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
  return {
    root: process.cwd(),
    port: 0,
    host: '127.0.0.1',
    authSecret: secret,
    browserCookiePath: '/',
    webRoot: process.cwd(),
    runtime: runtime as never,
    store: {
      listEvents: () => events,
      listEventsForSession: () => ({ events: [], nextCursor: 0, hasMore: false }),
      listEventsForThread: () => ({ events: [], nextCursor: 0, hasMore: false }),
      listRecentEventsForRun: () => [],
      listMessages: () => [],
      listMessagePage: () => ({ messages: [], nextCursor: 0, hasMore: false }),
      listThreadArtifacts: () => [],
      listRunArtifacts: () => [],
      getRun: () => undefined,
      getLatestRun: () => undefined,
      listActiveRunsForThread: () => [],
      getThread: () => undefined,
    } as never,
    providers: { catalog: async () => ({ providers: [] }) } as never,
    scheduler: { list: () => [], listTasks: () => [] } as never,
    skills: { list: () => [], health: () => [], listNames: () => [] } as never,
    plugins: { list: () => [], health: () => [], listNames: () => [] } as never,
    secrets: { list: () => [], health: () => [], listNames: () => [] } as never,
  };
}

describe('SSE agent stream', () => {
  it('returns 401 without authentication', async () => {
    const app = createApp(services());
    const response = await app.fetch(new Request('http://localhost/api/agent/stream'));
    expect(response.status).toBe(401);
  });

  it('returns 200 with valid authentication', async () => {
    const app = createApp(services());
    const response = await app.fetch(
      new Request(`http://localhost/api/agent/stream?token=${token}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
  });

  it('emits mapped SSE event types for runtime events', async () => {
    let publish: ((event: Record<string, unknown>) => void) | undefined;
    const gateway = services();
    gateway.runtime.subscribe = ((listener: (event: Record<string, unknown>) => void) => {
      publish = listener;
      return () => undefined;
    }) as never;
    const app = createApp(gateway);
    const response = await app.fetch(
      new Request(`http://localhost/api/agent/stream?token=${token}`),
    );
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    setImmediate(() => {
      publish?.({
        id: 1,
        type: 'model.delta',
        payload: { text: 'partial text' },
      });
    });

    let data = '';
    const start = Date.now();
    while (reader && Date.now() - start < 1_000) {
      const { value, done } = await reader.read();
      if (done) break;
      data += decoder.decode(value);
      if (data.includes('partial text')) break;
    }
    await reader?.cancel();

    expect(data).toContain('token');
    expect(data).toContain('partial text');
    expect(data).toContain('id: 1');
  });

  it('includes the original runtime event alongside the mapped SSE type', async () => {
    let publish: ((event: Record<string, unknown>) => void) | undefined;
    const gateway = services();
    gateway.runtime.subscribe = ((listener: (event: Record<string, unknown>) => void) => {
      publish = listener;
      return () => undefined;
    }) as never;
    const app = createApp(gateway);
    const response = await app.fetch(
      new Request(`http://localhost/api/agent/stream?token=${token}`),
    );
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    setImmediate(() => {
      publish?.({
        id: 1,
        type: 'run.started',
        runId: 'run-123',
        payload: { provider: 'ollama', model: 'test' },
      });
    });

    let data = '';
    const start = Date.now();
    while (reader && Date.now() - start < 1_000) {
      const { value, done } = await reader.read();
      if (done) break;
      data += decoder.decode(value);
      if (data.includes('status') && data.includes('run.started')) break;
    }
    await reader?.cancel();

    expect(data).toContain('status');
    expect(data).toContain('Thinking...');
    expect(data).toContain('run.started');
    expect(data).toContain('run-123');
  });

  it('filters events to the requested session id', async () => {
    let publish: ((event: Record<string, unknown>) => void) | undefined;
    const gateway = services();
    gateway.runtime.subscribe = ((listener: (event: Record<string, unknown>) => void) => {
      publish = listener;
      return () => undefined;
    }) as never;
    const app = createApp(gateway);
    const response = await app.fetch(
      new Request(`http://localhost/api/agent/stream?token=${token}&session_id=session-a`),
    );
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    setImmediate(() => {
      publish?.({
        id: 1,
        type: 'message.created',
        sessionId: 'session-a',
        payload: { text: 'allowed' },
      });
      publish?.({
        id: 2,
        type: 'message.created',
        sessionId: 'session-b',
        payload: { text: 'filtered' },
      });
    });

    let data = '';
    const start = Date.now();
    while (reader && Date.now() - start < 1_000) {
      const { value, done } = await reader.read();
      if (done) break;
      data += decoder.decode(value);
      if (data.includes('allowed')) break;
    }
    await reader?.cancel();

    expect(data).toContain('allowed');
    expect(data).not.toContain('filtered');
  });

  it('replays buffered events matching Last-Event-ID on reconnect', async () => {
    let publish: ((event: Record<string, unknown>) => void) | undefined;
    const gateway = services();
    gateway.runtime.subscribe = ((listener: (event: Record<string, unknown>) => void) => {
      publish = listener;
      return () => undefined;
    }) as never;
    const app = createApp(gateway);

    const firstResponse = await app.fetch(
      new Request(`http://localhost/api/agent/stream?token=${token}`),
    );
    const firstReader = firstResponse.body?.getReader();
    const decoder = new TextDecoder();

    setImmediate(() => {
      publish?.({
        id: 1,
        type: 'message.created',
        sessionId: 'session-x',
        payload: { text: 'first' },
      });
      publish?.({
        id: 2,
        type: 'message.created',
        sessionId: 'session-x',
        payload: { text: 'second' },
      });
    });

    let firstData = '';
    const start = Date.now();
    while (firstReader && Date.now() - start < 1_000) {
      const { value, done } = await firstReader.read();
      if (done) break;
      firstData += decoder.decode(value);
      if (firstData.includes('second')) break;
    }
    await firstReader?.cancel();

    const secondResponse = await app.fetch(
      new Request(`http://localhost/api/agent/stream?token=${token}`, {
        headers: { 'Last-Event-ID': '1' },
      }),
    );
    const secondReader = secondResponse.body?.getReader();
    let secondData = '';
    const start2 = Date.now();
    while (secondReader && Date.now() - start2 < 1_000) {
      const { value, done } = await secondReader.read();
      if (done) break;
      secondData += decoder.decode(value);
      if (secondData.includes('first') || secondData.includes('second')) break;
    }
    await secondReader?.cancel();

    expect(firstData).toContain('first');
    expect(firstData).toContain('second');
    expect(secondData).toContain('second');
    expect(secondData).not.toContain('"first"');
  });
});
