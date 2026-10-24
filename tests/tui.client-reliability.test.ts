import { mkdtemp, rm } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { Tui } from '../src/ui/tui.js';
import { buildThreadPresentation } from '../src/web/presentation.js';

const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
type Subscription = { after: number; sessionId?: string; limit: number };
async function fixture(
  override: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> = async () => false,
  replay?: (socket: WebSocket, message: Subscription) => void,
) {
  const requests: string[] = [];
  const subscriptions: Array<{ after: number; sessionId?: string; limit: number }> = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (await override(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://fixture');
    const path = url.pathname;
    let body: unknown;
    if (path === '/api/sessions')
      body = {
        sessions: ['A', 'B'].map((id) => ({ id, title: `Session ${id}`, status: 'active' })),
      };
    else if (path.startsWith('/api/sessions/'))
      body = {
        threads: [{ id: path.split('/').at(-1), title: `Thread ${path.split('/').at(-1)}` }],
      };
    else if (path.endsWith('/presentation'))
      body = {
        messages: [
          {
            id: `${path.split('/')[3]}-message`,
            role: 'assistant',
            markdown: `BODY-${path.split('/')[3]}`,
          },
        ],
        hasMore: false,
        nextCursor: 0,
      };
    else if (path.endsWith('/run-state')) body = { activeRunId: null, events: [], lastEventId: 0 };
    else if (path === '/api/providers')
      body = { active: { name: 'fixture', model: 'model' }, providers: [] };
    else if (path === '/api/plugins') body = { plugins: [], health: [] };
    else if (path === '/api/secrets') body = { names: [] };
    else
      body = {
        [path.split('/').at(-1) === 'memory' ? 'memories' : (path.split('/').at(-1) ?? '')]: [],
      };
    json(res, body);
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'subscribe') {
        subscriptions.push(message);
        if (replay) {
          replay(socket, message);
          return;
        }
        socket.send(
          JSON.stringify({ type: 'replay.complete', nextCursor: message.after, hasMore: false }),
        );
      }
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const root = await mkdtemp(join(tmpdir(), 'nuaai-reliability-'));
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
    createElement(Tui, { root, baseUrl: `http://127.0.0.1:${address.port}`, token: 'fixture' }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  return {
    requests,
    subscriptions,
    sockets,
    stdin,
    frame: () => frame,
    send: (value: unknown) => {
      for (const socket of sockets.clients) socket.send(JSON.stringify(value));
    },
    async close() {
      app.unmount();
      app.cleanup();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

it(
  'T07 pages real durable history through Ink and keeps the visible anchor when older rows arrive',
  { timeout: 15_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-reliability-db-'));
    const store = new DatabaseStore(openAppDatabase(root));
    const { thread } = store.createSession('History', 1);
    for (let index = 0; index < 205; index += 1)
      store.addMessage(
        thread.id,
        'user',
        `HISTORY-${String(index).padStart(3, '0')}`,
        'fixture',
        'model',
        index + 2,
      );
    const held = gate();
    let olderWaiting = false;
    let olderResponses = 0;
    const f = await fixture(async (req, res) => {
      if (!req.url?.includes('/presentation')) return false;
      const url = new URL(req.url, 'http://fixture');
      const before = url.searchParams.has('before')
        ? Number(url.searchParams.get('before'))
        : undefined;
      const page = buildThreadPresentation(store, thread.id, { before, limit: 100 });
      if (before && !olderWaiting) {
        olderWaiting = true;
        await held.promise;
      }
      if (before) olderResponses += 1;
      json(res, page);
      return true;
    });
    const visible = () => f.frame().match(/HISTORY-\d{3}/gu) ?? [];
    try {
      await expect.poll(f.frame).toContain('HISTORY-204');
      for (let key = 0; key < 45 && !olderWaiting; key += 1) {
        f.stdin.write('\u001b[5~');
        await pause(20);
      }
      expect(olderWaiting).toBe(true);
      const anchor = visible();
      expect(anchor.length).toBeGreaterThan(0);
      held.release();
      await expect.poll(() => olderResponses).toBe(1);
      await pause();
      expect(visible()).toEqual(anchor);
      for (let key = 0; key < 90 && !f.frame().includes('HISTORY-000'); key += 1) {
        f.stdin.write('\u001b[5~');
        await pause(20);
        expect(new Set(visible()).size).toBe(visible().length);
      }
      expect(f.frame()).toContain('HISTORY-000');
      expect(olderResponses).toBe(2);
      // A normal refresh must not evict already loaded older pages or move the anchor.
      f.stdin.write('\u0012');
      await expect.poll(f.frame).toContain('Runtime refreshed');
      expect(f.frame()).toContain('HISTORY-000');
      for (let key = 0; key < 90 && !f.frame().includes('HISTORY-204'); key += 1) {
        f.stdin.write('\u001b[6~');
        await pause(20);
      }
      expect(f.frame()).toContain('HISTORY-204');
      expect(new Set(visible()).size).toBe(visible().length);
      f.stdin.write('/sessions ');
      await expect.poll(f.frame).toContain('› /sessions');
      f.stdin.write('\r');
      await expect.poll(f.frame).toContain('Conversations');
      f.stdin.write('Session A');
      await expect.poll(f.frame).toContain('Search: Session A');
      f.stdin.write('\r');
      await expect.poll(f.frame).toContain('HISTORY-204');
      for (let key = 0; key < 45 && olderResponses < 3; key += 1) {
        f.stdin.write('\u001b[5~');
        await pause(20);
      }
      expect(olderResponses).toBe(3);
    } finally {
      held.release();
      await f.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('T06 retries a lost acceptance across reconnect with the same key and preserves edits made in flight', async () => {
  const held = gate();
  const nextAcceptance = gate();
  const submissions: Array<{ threadId: string; input: string; idempotencyKey?: string }> = [];
  const durable = new Map<string, string>();
  let drop = true;
  let hold = false;
  const f = await fixture(async (req, res) => {
    if (req.url !== '/api/runs') return false;
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const submission = JSON.parse(body);
    submissions.push(submission);
    const key = submission.idempotencyKey ?? `missing-${submissions.length}`;
    if (!durable.has(key)) durable.set(key, submission.input);
    if (drop) {
      drop = false;
      req.socket.destroy();
      return true;
    }
    if (hold) await held.promise;
    if (submissions.length === 3) await nextAcceptance.promise;
    json(res, { id: `run-${key}` });
    return true;
  });
  try {
    await expect.poll(f.frame).toContain('BODY-A');
    f.stdin.write('retry safely');
    await expect.poll(f.frame).toContain('retry safely');
    f.stdin.write('\r');
    await expect.poll(f.frame).toContain('fetch failed');
    expect(f.frame()).toContain('retry safely');
    for (const socket of f.sockets.clients) socket.close(1012, 'reconnect');
    await expect.poll(() => f.subscriptions.length, { timeout: 4000 }).toBeGreaterThan(1);
    hold = true;
    f.stdin.write('\r');
    await expect.poll(() => submissions.length).toBe(2);
    f.stdin.write(' plus next draft');
    await expect.poll(f.frame).toContain('retry safely plus next draft');
    held.release();
    await expect.poll(f.frame).toContain('Run accepted');
    expect(f.frame()).toContain('retry safely plus next draft');
    expect(submissions[0]?.idempotencyKey).toMatch(/^[a-zA-Z0-9-]+$/u);
    expect(submissions[1]?.idempotencyKey).toBe(submissions[0]?.idempotencyKey);
    expect([...durable.values()]).toEqual(['retry safely']);
    f.stdin.write('\r');
    await expect.poll(() => submissions.length).toBe(3);
    expect(submissions[2]?.idempotencyKey).not.toBe(submissions[0]?.idempotencyKey);
    await expect.poll(f.frame).toContain('Applying…');
    // The previous acceptance notice is still visible while this response is held;
    // it cannot prove that the new submission has been accepted or rendered.
    expect(f.frame()).toContain('Run accepted');
    expect(f.frame()).toContain('› retry safely plus next draft');
    nextAcceptance.release();
    await expect.poll(f.frame).not.toContain('› retry safely plus next draft');
    expect([...durable.values()]).toEqual(['retry safely', 'retry safely plus next draft']);
  } finally {
    held.release();
    nextAcceptance.release();
    await f.close();
  }
});

it.each(['presentation', 'run-state', 'catalog', 'subscribe'])(
  'T03 reconciles completion at the %s boundary without manual refresh',
  async (boundary) => {
    const terminalReplay = gate();
    if (boundary !== 'run-state') terminalReplay.release();
    let completed = false;
    let live: WebSocket | undefined;
    const terminal = {
      id: 3,
      type: 'run.completed',
      sessionId: 'A',
      threadId: 'A',
      runId: 'run',
      payload: {},
    };
    const finish = () => {
      const wasComplete = completed;
      completed = true;
      if (!wasComplete && live?.readyState === WebSocket.OPEN)
        live.send(JSON.stringify({ type: 'event', event: terminal }));
    };
    const f = await fixture(
      async (req, res) => {
        if (req.url?.endsWith('/presentation')) {
          const wasComplete = completed;
          if (boundary === 'presentation') finish();
          json(res, {
            messages: [
              {
                id: wasComplete ? 'final' : 'old',
                role: 'assistant',
                markdown: wasComplete ? 'FINAL-RECONCILED' : 'before completion',
              },
            ],
            hasMore: false,
            nextCursor: 0,
          });
          return true;
        }
        if (req.url?.endsWith('/run-state')) {
          const wasComplete = completed;
          if (boundary === 'run-state') finish();
          json(res, {
            activeRunId: wasComplete ? null : 'run',
            events: [],
            lastEventId: wasComplete ? 3 : 2,
          });
          return true;
        }
        if (req.url === '/api/memory' && boundary === 'catalog') finish();
        return false;
      },
      (socket, message) => {
        live = socket;
        if (boundary === 'subscribe') finish();
        void terminalReplay.promise.then(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (completed && message.after < 3)
            socket.send(JSON.stringify({ type: 'event', event: terminal }));
          socket.send(
            JSON.stringify({
              type: 'replay.complete',
              nextCursor: completed ? 3 : message.after,
              hasMore: false,
            }),
          );
        });
      },
    );
    try {
      await expect.poll(f.frame).toContain('FINAL-RECONCILED');
      if (boundary === 'run-state') {
        // The cursor is captured before presentation. A completed answer can
        // render with the older active-run snapshot until terminal replay arrives.
        await expect.poll(() => f.subscriptions.length).toBeGreaterThan(0);
        expect(f.frame()).toContain('Working…');
        terminalReplay.release();
      }
      await expect.poll(f.frame).not.toContain('Working…');
      expect(f.frame().split('FINAL-RECONCILED')).toHaveLength(2);
      expect(
        f.subscriptions.every(
          (entry) => entry.after < Number.MAX_SAFE_INTEGER && entry.sessionId === 'A',
        ),
      ).toBe(true);
    } finally {
      terminalReplay.release();
      await f.close();
    }
  },
);

it('T03 rebuilds snapshot activity and follows replay pages without duplicate deltas, including reconnect', async () => {
  const terminalGate = gate();
  let completed = false;
  const started = {
    id: 1,
    sessionId: 'A',
    threadId: 'A',
    runId: 'run',
    type: 'run.started',
    payload: { provider: 'fixture', model: 'model' },
  };
  const delta = { ...started, id: 2, type: 'model.delta', payload: { text: 'PARTIAL' } };
  const tail = { ...delta, id: 3, payload: { text: 'TAIL' } };
  const f = await fixture(
    async (req, res) => {
      if (req.url?.endsWith('/run-state')) {
        json(res, {
          activeRunId: completed ? null : 'run',
          events: completed ? [] : [started, delta],
          lastEventId: completed ? 4 : 2,
        });
        return true;
      }
      if (req.url?.endsWith('/presentation')) {
        json(res, {
          messages: completed ? [{ id: 'final', role: 'assistant', markdown: 'FINAL-PAGED' }] : [],
          hasMore: false,
          nextCursor: 0,
        });
        return true;
      }
      return false;
    },
    (socket, message) => {
      if (message.after === 2) {
        socket.send(JSON.stringify({ type: 'event', event: tail }));
        socket.send(JSON.stringify({ type: 'event', event: tail }));
        socket.send(JSON.stringify({ type: 'replay.complete', nextCursor: 3, hasMore: true }));
      } else if (message.after === 3) {
        void terminalGate.promise.then(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          completed = true;
          socket.send(
            JSON.stringify({
              type: 'event',
              event: { ...started, id: 4, type: 'run.completed', payload: {} },
            }),
          );
          socket.send(JSON.stringify({ type: 'replay.complete', nextCursor: 4, hasMore: false }));
        });
      } else
        socket.send(
          JSON.stringify({ type: 'replay.complete', nextCursor: message.after, hasMore: false }),
        );
    },
  );
  try {
    await expect.poll(f.frame).toContain('PARTIALTAIL');
    expect(f.frame()).not.toContain('TAILTAIL');
    await expect.poll(() => f.subscriptions.some((entry) => entry.after === 3)).toBe(true);
    for (const socket of f.sockets.clients) socket.close(1012, 'fixture reconnect');
    await expect
      .poll(() => f.subscriptions.filter((entry) => entry.after === 2).length, { timeout: 4000 })
      .toBe(2);
    await expect.poll(f.frame).toContain('PARTIALTAIL');
    terminalGate.release();
    await expect.poll(f.frame).toContain('FINAL-PAGED');
    expect(f.frame()).not.toContain('Working…');
  } finally {
    terminalGate.release();
    await f.close();
  }
});

it('T05 a held optional catalog cannot delay healthy catalogs, acceptance, or cancellation', async () => {
  const held = gate();
  let cancelled = false;
  let pendingApproval = false;
  let approved = false;
  const f = await fixture(async (req, res) => {
    if (req.url?.startsWith('/api/approvals?')) {
      json(res, {
        approvals: pendingApproval
          ? [
              {
                id: 'approval',
                runId: 'active',
                threadId: 'A',
                toolName: 'workspace.write',
                status: 'pending',
                payloadHash: 'bound-payload',
                target: 'fixture.txt',
                risk: 'write',
                preview: {
                  version: 1,
                  kind: 'write',
                  summary: 'Fixture write',
                  fields: [],
                  context: { source: 'tui', client: 'operator' },
                },
                providerOwned: false,
                createdAt: Date.now(),
                expiresAt: Date.now() + 60000,
              },
            ]
          : [],
      });
      return true;
    }
    if (req.url === '/api/approvals/approval/approve') {
      approved = true;
      pendingApproval = false;
      json(res, { ok: true });
      return true;
    }
    if (req.url === '/api/memory') {
      await held.promise;
      json(res, { memories: [] });
      return true;
    }
    if (req.url?.endsWith('/run-state')) {
      json(res, { activeRunId: 'active', events: [], lastEventId: 0 });
      return true;
    }
    if (req.url === '/api/runs') {
      json(res, { id: 'accepted' });
      return true;
    }
    if (req.url === '/api/runs/active/cancel') {
      cancelled = true;
      json(res, { ok: true });
      return true;
    }
    return false;
  });
  try {
    await expect.poll(f.frame).toContain('fixture/model');
    f.stdin.write('chat while memory is slow');
    await expect.poll(f.frame).toContain('chat while memory is slow');
    f.stdin.write('\r');
    await expect.poll(f.frame).toContain('Run accepted');
    await pause();
    f.stdin.write('\u0018');
    await expect.poll(() => cancelled).toBe(true);
    pendingApproval = true;
    f.send({ type: 'approvals.invalidated' });
    await expect.poll(f.frame).toContain('Approval required');
    f.stdin.write('\u0019');
    await expect.poll(() => approved).toBe(true);
    await expect.poll(f.frame).toContain('Action approved');
  } finally {
    held.release();
    await f.close();
  }
});

it.each(['tasks', 'schedules', 'memory', 'skills', 'plugins', 'providers', 'secrets', 'approvals'])(
  'T05 isolates unavailable %s from chat and cancellation',
  async (resource) => {
    let submitted = false;
    let cancelled = false;
    const f = await fixture(async (req, res) => {
      if (req.url?.split('?')[0] === `/api/${resource}`) {
        json(res, { error: `${resource} unavailable` }, 503);
        return true;
      }
      if (req.url?.endsWith('/run-state')) {
        json(res, { activeRunId: 'active', events: [], lastEventId: 0 });
        return true;
      }
      if (req.url === '/api/runs/active/cancel') {
        cancelled = true;
        json(res, { ok: true });
        return true;
      }
      if (req.url === '/api/runs') {
        submitted = true;
        json(res, { id: 'accepted' });
        return true;
      }
      return false;
    });
    try {
      await expect.poll(f.frame).toContain(`${resource} unavailable`);
      expect(f.frame()).not.toContain('Disconnected');
      f.stdin.write('\u0018');
      await expect.poll(() => cancelled).toBe(true);
      await expect.poll(f.frame).toContain('Cancellation requested');
      f.stdin.write('harmless fixture input');
      await expect.poll(f.frame).toContain('harmless fixture input');
      f.stdin.write('\r');
      await expect.poll(() => submitted).toBe(true);
    } finally {
      await f.close();
    }
  },
);

it('T04 single-flights an empty startup and concurrent invalidation while create is held', async () => {
  const held = gate();
  let creates = 0;
  const keys: string[] = [];
  const f = await fixture(async (req, res) => {
    if (req.url === '/api/sessions' && req.method === 'GET') {
      json(res, { sessions: [] });
      return true;
    }
    if (
      ['/api/sessions', '/api/sessions/resolve'].includes(req.url ?? '') &&
      req.method === 'POST'
    ) {
      creates += 1;
      let body = '';
      for await (const chunk of req) body += String(chunk);
      keys.push(JSON.parse(body).sourceKey);
      await held.promise;
      json(res, {
        session: { id: 'A', title: 'Session A', status: 'active' },
        thread: { id: 'A', title: 'Thread A' },
      });
      return true;
    }
    return false;
  });
  try {
    await expect.poll(() => creates).toBeGreaterThan(0);
    f.send({ type: 'approvals.invalidated' });
    await pause();
    held.release();
    await expect.poll(f.frame).toContain('BODY-A');
    expect(creates).toBe(1);
    expect(keys).toEqual(['tui:main']);
    expect(f.requests).toContain('POST /api/sessions/resolve');
    expect(f.requests.filter((path) => path === 'GET /api/sessions')).toHaveLength(1);
  } finally {
    held.release();
    await f.close();
  }
});

it('T02 hides retired live output while a new conversation is still loading', async () => {
  const held = gate();
  let waiting = false;
  const f = await fixture(async (req, res) => {
    if (req.url === '/api/threads/A/run-state') {
      json(res, {
        activeRunId: 'active',
        lastEventId: 1,
        events: [
          { id: 1, type: 'model.delta', runId: 'active', payload: { text: 'RETIRED-LIVE-OUTPUT' } },
        ],
      });
      return true;
    }
    if (req.url === '/api/threads/B/run-state') {
      waiting = true;
      await held.promise;
      json(res, { activeRunId: null, events: [], lastEventId: 1 });
      return true;
    }
    return false;
  });
  try {
    await expect.poll(f.frame).toContain('RETIRED-LIVE-OUTPUT');
    f.stdin.write('\u001b[1;5B');
    await expect.poll(() => waiting).toBe(true);
    await pause();
    expect(f.frame()).not.toContain('RETIRED-LIVE-OUTPUT');
    expect(f.frame()).not.toContain('BODY-A');
    held.release();
    await expect.poll(f.frame).toContain('BODY-B');
  } finally {
    held.release();
    await f.close();
  }
});

it.each([
  '/api/sessions',
  '/api/sessions/A',
  '/api/threads/A/run-state',
  '/api/threads/A/presentation',
])('T02 rejects an old A generation after A → B → A with %s held', async (path) => {
  const held = gate();
  let armed = false;
  let waiting = false;
  const f = await fixture(async (req, res) => {
    if (!armed || req.url !== path) return false;
    armed = false;
    waiting = true;
    await held.promise;
    const responses: Record<string, unknown> = {
      '/api/sessions': { sessions: [{ id: 'A', title: 'STALE-SESSION', status: 'active' }] },
      '/api/sessions/A': { threads: [{ id: 'A', title: 'STALE-THREAD' }] },
      '/api/threads/A/run-state': { activeRunId: 'STALE-RUN', events: [], lastEventId: 0 },
      '/api/threads/A/presentation': {
        messages: [{ id: 'stale', role: 'assistant', markdown: 'STALE-BODY' }],
      },
    };
    json(res, responses[path]);
    return true;
  });
  try {
    await expect.poll(f.frame).toContain('BODY-A');
    armed = true;
    f.send({ type: 'approvals.invalidated' });
    await expect.poll(() => waiting).toBe(true);
    f.stdin.write('\u001b[1;5B');
    await expect.poll(f.frame).toContain('BODY-B');
    expect(f.frame()).toContain('Session B');
    f.stdin.write('\u001b[1;5A');
    await expect.poll(f.frame).toContain('BODY-A');
    held.release();
    await pause();
    expect(f.frame()).toContain('Thread A');
    expect(f.frame()).toContain('Session A');
    expect(f.frame()).not.toContain('STALE');
    expect(f.frame()).not.toContain('Working…');
  } finally {
    held.release();
    await f.close();
  }
});

it('T02 fences a held A refresh when keyboard navigation commits B then A', async () => {
  const held = gate();
  let hold = false;
  let waiting = false;
  const f = await fixture(async (req, res) => {
    if (hold && req.url?.startsWith('/api/threads/A/presentation')) {
      waiting = true;
      await held.promise;
      json(res, { messages: [{ id: 'stale', role: 'assistant', markdown: 'STALE-A' }] });
      return true;
    }
    return false;
  });
  try {
    await expect.poll(f.frame).toContain('BODY-A');
    hold = true;
    f.send({ type: 'approvals.invalidated' });
    await expect.poll(() => waiting).toBe(true);
    f.stdin.write('\u001b[1;5B');
    await expect.poll(f.frame).toContain('BODY-B');
    held.release();
    await pause();
    expect(f.frame()).toContain('Thread B');
    expect(f.frame()).not.toContain('STALE-A');
    hold = false;
    f.stdin.write('\u001b[1;5A');
    await expect.poll(f.frame).toContain('BODY-A');
    expect(f.frame()).not.toContain('BODY-B');
  } finally {
    held.release();
    await f.close();
  }
});
