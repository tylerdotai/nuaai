import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { createElement } from 'react';
import { expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { Tui } from '../src/ui/tui.js';

export async function workflowHarness(
  initialMessages?: Record<string, Array<{ id: string; role: string; markdown: string }>>,
) {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-tui-workflow-'));
  await mkdir(join(root, '.nuaai'));
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  let rejectRuns = false;
  const messages: Record<
    string,
    Array<{ id: string; role: string; markdown: string }>
  > = initialMessages ?? {
    a: [{ id: 'a1', role: 'assistant', markdown: 'A response' }],
    b: [{ id: 'b1', role: 'assistant', markdown: 'B response' }],
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    let text = '';
    for await (const chunk of req) text += String(chunk);
    const body = text ? JSON.parse(text) : {};
    requests.push({ path: url.pathname + url.search, method: req.method ?? 'GET', body });
    let result: unknown;
    if (url.pathname === '/api/sessions')
      result = { sessions: [{ id: 's', title: 'Workflow session', status: 'active' }] };
    else if (url.pathname === '/api/sessions/s')
      result = {
        threads: [
          { id: 'a', title: 'Thread A' },
          { id: 'b', title: 'Thread B' },
        ],
      };
    else if (url.pathname.endsWith('/presentation')) {
      const id = url.pathname.split('/')[3];
      const all = messages[id] ?? [];
      const older = url.searchParams.has('before');
      result = {
        messages: older ? all.slice(0, -1) : all.slice(-1),
        hasMore: !older && all.length > 1,
        nextCursor: older ? 0 : 10,
      };
    } else if (url.pathname.endsWith('/run-state')) result = { activeRunId: null, lastEventId: 0 };
    else if (url.pathname === '/api/providers')
      result = {
        active: { name: 'fixture', model: 'fixture-model' },
        providers: [{ name: 'fixture', available: true, models: ['fixture-model'] }],
      };
    else if (url.pathname === '/api/plugins') result = { plugins: [], health: [] };
    else if (url.pathname === '/api/secrets') result = { names: [] };
    else if (url.pathname === '/api/runs' && req.method === 'POST') {
      if (rejectRuns) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'controlled rejection' }));
        return;
      }
      result = { id: 'accepted-run' };
    } else result = { [url.pathname.split('/').at(-1) ?? '']: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let stop = () => {};
  let input: PassThrough;
  let output = '';
  const frame = () => {
    const starts = [
      ...output.matchAll(/\n NUAAI\n (?:Connected|Connecting|Loading|Disconnected)/gu),
    ];
    return output.slice(starts.at(-1)?.index ?? 0);
  };
  const launch = () => {
    input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => input,
      ref: () => input,
      unref: () => input,
    });
    const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 36 });
    output = '';
    stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    const app = render(createElement(Tui, { root, baseUrl, token: 'workflow-test' }), {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    });
    stop = () => {
      app.unmount();
      app.cleanup();
    };
  };
  launch();
  const send = async (bytes: string, expected?: string) => {
    await expect.poll(() => !frame().includes('Applying…'), { timeout: 3000 }).toBe(true);
    // Let Ink commit passive input effects after a rendered readiness frame.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = output.length;
    input.write(bytes);
    if (expected)
      await expect
        .poll(() => (output.length > before ? frame() : ''), { timeout: 3000 })
        .toContain(expected);
    else await new Promise((resolve) => setTimeout(resolve, 70));
  };
  return {
    terminalOutput: () => output,
    root,
    baseUrl,
    requests,
    messages,
    frame,
    send,
    rejectRuns: (value: boolean) => {
      rejectRuns = value;
    },
    restart: async () => {
      stop();
      launch();
      await expect.poll(frame).toContain('Connected');
    },
    close: async () => {
      stop();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
