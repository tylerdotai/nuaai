import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { Tui } from '../src/ui/tui.js';

it('routes raw keyboard shortcuts, preserves drafts, and keeps approval and form scopes safe', async () => {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const sessions = [{ id: 'session', title: 'Keyboard test', status: 'active' }];
  let pending = false;
  const server = createServer(async (req, res) => {
    const path = req.url ?? '';
    let body: unknown;
    if (req.method === 'POST') {
      let text = '';
      for await (const chunk of req) text += String(chunk);
      const payload = text ? JSON.parse(text) : {};
      writes.push({ path, body: payload });
      if (path === '/api/sessions') {
        const session = {
          id: `session-${sessions.length}`,
          title: payload.title,
          status: 'active',
        };
        sessions.push(session);
        body = { session, thread: { id: 'thread', title: 'Main' } };
      } else if (path.endsWith('/deny')) {
        pending = false;
        body = { ok: true };
      } else body = { id: 'keyboard-run' };
    } else if (path === '/api/sessions') body = { sessions };
    else if (/^\/api\/sessions\/[^/]+$/u.test(path))
      body = { threads: [{ id: 'thread', title: 'Main' }] };
    else if (path === '/api/providers')
      body = {
        active: { name: 'test', model: 'keyboard-model' },
        providers: [{ name: 'test', available: true, models: ['keyboard-model'] }],
      };
    else if (path.startsWith('/api/approvals?'))
      body = {
        approvals: pending
          ? [
              {
                id: 'keyboard-approval',
                threadId: 'thread',
                runId: 'run',
                toolName: 'workspace.write',
                status: 'pending',
                payloadHash: 'keyboard-hash',
                target: 'notes.md',
                risk: 'write',
                createdAt: Date.now(),
                expiresAt: Date.now() + 60000,
                preview: {
                  version: 1,
                  kind: 'write',
                  summary: 'Write notes',
                  fields: [],
                  context: { source: 'tui', client: 'operator' },
                },
              },
            ]
          : [],
      };
    else if (path.endsWith('/presentation')) body = { messages: [] };
    else if (path.endsWith('/run-state')) body = { activeRunId: null };
    else if (path === '/api/plugins') body = { plugins: [], health: [] };
    else if (path === '/api/secrets') body = { names: [] };
    else body = { [path.split('/').at(-1)?.split('?')[0] ?? '']: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
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
  const root = await mkdtemp(join(tmpdir(), 'nuaai-shortcuts-'));
  await mkdir(join(root, '.nuaai'));
  const app = render(
    createElement(Tui, {
      root,
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'keyboard-test',
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
    output = '';
    stdin.write(bytes);
    await expect.poll(() => output).toContain(expected);
  };
  try {
    await expect.poll(() => output).toContain('keyboard-model');
    await send('keep this draft', 'keep this draft');
    await send('\u001bm', 'Choose model');
    await send('\u001b', 'keep this draft');
    await send('\u001b[109;5u', 'Choose model');
    await send('\u001b', 'keep this draft');
    await send('\u000f', 'Choose provider');
    await send('\u001b', 'keep this draft');
    await send('\u001bh', 'Commands and shortcuts');
    await send('model', 'Ctrl-P / Alt-M');
    await send('\r', 'Choose model');
    await send('\u001b', 'Commands and shortcuts');
    await send('\u001b', 'keep this draft');
    await send('\u0007', 'Commands and shortcuts');
    await send('\u001b', 'keep this draft');
    await send('\u0006', 'Conversations');
    await send('\u001b', 'keep this draft');
    await send('\u001bs', 'Settings');
    await send('\u001b', 'keep this draft');
    await send('\u001bd', 'Terminal preference saved');
    await expect.poll(() => output).toContain('keep this draft');
    await send('\u000e', 'keep this draft');
    await expect.poll(() => sessions.length).toBe(2);
    expect(writes.filter((entry) => entry.path === '/api/sessions')).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Enter remains submission, never model selection (Ctrl-M shares the same byte).
    await send('\r', 'Run accepted');
    expect(writes.find((entry) => entry.path === '/api/runs')?.body.input).toBe('keep this draft');
    pending = true;
    await send('\u001ba', 'Approval required');
    // A picker must never allow a decision against an obscured action card.
    await send('\u0006', 'Conversations');
    stdin.write('\u000e');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(writes.filter((entry) => entry.path.endsWith('/deny'))).toHaveLength(0);
    expect(sessions).toHaveLength(2);
    await send('\u001b', 'Approval required');
    await send('\u000e', 'Action denied');
    expect(writes.find((entry) => entry.path.endsWith('/deny'))?.body).toEqual({
      payloadHash: 'keyboard-hash',
    });
    expect(sessions).toHaveLength(2);
    await send('/schedule ', '/schedule');
    await send('\r', 'Automation name');
    stdin.write('\u000e');
    stdin.write('\u001bm');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sessions).toHaveLength(2);
    expect(output).not.toContain('Choose model');
    await send('\u001b', 'Left automation editor');
  } finally {
    app.unmount();
    app.cleanup();
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
