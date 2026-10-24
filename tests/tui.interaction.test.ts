import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { Tui } from '../src/ui/tui.js';

it('switches from an offline local model to Codex through keyboard pickers and saves settings', async () => {
  let active = { name: 'ollama', model: 'local-model' };
  const switches: unknown[] = [];
  const mutations: string[] = [];
  let memories = [{ id: 'memory-1', content: 'Keep this until confirmed', hasEmbedding: false }];
  let enabled = true;
  let pendingApproval = true;
  const approvalPayloads: unknown[] = [];
  const createdSchedules: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe('Bearer terminal-test');
    const path = req.url ?? '';
    let body: unknown = {};
    if (path === '/api/providers/switch') {
      let input = '';
      for await (const chunk of req) input += String(chunk);
      const selection = JSON.parse(input) as { provider: string; model: string };
      switches.push(selection);
      active = { name: selection.provider, model: selection.model };
      body = { active };
    } else if (path === '/api/providers') {
      body = {
        active,
        providers: [
          {
            name: 'ollama',
            available: false,
            detail: 'Local server offline',
            models: ['local-model'],
          },
          {
            name: 'codex',
            available: true,
            detail: 'OAuth ready',
            models: ['codex-test-a', 'codex-test-b'],
          },
        ],
      };
    } else if (path.startsWith('/api/approvals?')) {
      body = {
        approvals: pendingApproval
          ? [
              {
                id: 'approval-1',
                runId: 'run-1',
                threadId: 'thread',
                toolName: 'workspace.write',
                status: 'pending',
                payloadHash: 'exact-test-hash',
                target: 'notes.md',
                risk: 'write',
                preview: {
                  version: 1,
                  kind: 'write',
                  summary: 'Write notes',
                  fields: [{ label: 'Path', value: 'notes.md' }],
                  context: { source: 'tui', client: 'operator' },
                },
                providerOwned: false,
                createdAt: Date.now(),
                expiresAt: Date.now() + 60000,
              },
            ]
          : [],
      };
    } else if (path === '/api/approvals/approval-1/approve') {
      let input = '';
      for await (const chunk of req) input += String(chunk);
      approvalPayloads.push(JSON.parse(input));
      pendingApproval = false;
      body = { ok: true };
    } else if (path === '/api/memory') body = { memories };
    else if (path === '/api/memory/memory-1' && req.method === 'DELETE') {
      mutations.push('delete-memory');
      memories = [];
      body = { ok: true };
    } else if (path === '/api/schedules' && req.method === 'POST') {
      let input = '';
      for await (const chunk of req) input += String(chunk);
      const schedule = { ...JSON.parse(input), id: 'created-schedule' };
      createdSchedules.push(schedule);
      body = schedule;
    } else if (path === '/api/schedules')
      body = {
        schedules: [
          ...createdSchedules,
          {
            id: 'schedule-1',
            name: 'Daily check',
            type: 'manual',
            expression: 'manual',
            agentInput: 'Check status',
            enabled,
            nextRunAt: null,
          },
        ],
      };
    else if (path === '/api/schedules/schedule-1/pause') {
      mutations.push('pause-schedule');
      enabled = false;
      body = { ok: true };
    } else if (path === '/api/sessions') {
      body = { sessions: [{ id: 'session', title: 'Terminal test', status: 'active' }] };
    } else if (path === '/api/sessions/session') {
      body = { threads: [{ id: 'thread', title: 'Main thread' }] };
    } else if (path.endsWith('/presentation')) body = { messages: [] };
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
  if (!address || typeof address === 'string') throw new Error('No test server address');
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 32 });
  let output = '';
  stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  const root = await mkdtemp(join(tmpdir(), 'nuaai-terminal-'));
  await mkdir(join(root, '.nuaai'));
  const app = render(
    createElement(Tui, {
      root,
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'terminal-test',
    }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  try {
    await expect.poll(() => output).toContain('ollama/local-model');
    stdin.write('/provider codex');
    await expect.poll(() => output).toContain('› /provider codex');
    stdin.write('\r');
    await expect.poll(() => output).toContain('Choose model');
    stdin.write('test-b');
    await expect.poll(() => output).toContain('1 entries');
    stdin.write('\r');
    await expect.poll(() => switches).toEqual([{ provider: 'codex', model: 'codex-test-b' }]);
    await expect.poll(() => output).toContain('Model saved · codex / codex-test-b');
    stdin.write('\u001b');
    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write('/settings ');
    await expect.poll(() => output).toContain('› /settings');
    stdin.write('\r');
    await expect.poll(() => output).toContain('Model · codex-test-b');
    stdin.write('\u001b');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write('/unknown-command');
    await expect.poll(() => output).toContain('› /unknown-command');
    stdin.write('\r');
    await expect.poll(() => output).toContain('Unknown command /unknown-command');
    const command = async (text: string): Promise<void> => {
      stdin.write('\u001b');
      await new Promise((resolve) => setTimeout(resolve, 40));
      stdin.write('\u001b');
      await new Promise((resolve) => setTimeout(resolve, 40));
      output = '';
      stdin.write(`${text} `);
      await expect.poll(() => output).toContain(text);
      stdin.write('\r');
    };
    await command('/memory');
    await expect.poll(() => output).toContain('Search memories');
    stdin.write('\r');
    await expect.poll(() => output).toContain('Memory details');
    expect(mutations).toEqual([]);
    stdin.write('Delete memory');
    await expect.poll(() => output).toContain('Search: Delete memory');
    stdin.write('\r');
    await expect.poll(() => output).toContain('Confirm deletion');
    expect(mutations).toEqual([]);
    stdin.write('Delete permanently');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write('\r');
    await expect.poll(() => mutations).toEqual(['delete-memory']);
    await expect.poll(() => output).toContain('Deletion verified');
    await command('/schedules');
    await expect.poll(() => output).toContain('Automations');
    stdin.write('\r');
    await expect.poll(() => output).toContain('Daily check');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write('Pause');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write('\r');
    await expect.poll(() => mutations).toContain('pause-schedule');
    await expect.poll(() => output).toContain('Schedule paused');
    await command('/settings');
    await expect.poll(() => output).toContain('Transcript spacing');
    stdin.write('spacing');
    await expect.poll(() => output).toContain('Search: spacing');
    stdin.write('\r');
    await expect
      .poll(async () => JSON.parse(await readFile(join(root, '.nuaai/tui.json'), 'utf8')))
      .toEqual({ compact: true, toolDetails: false });
    await command('/approvals');
    await expect.poll(() => output).toContain('Review the inline action card');
    await expect.poll(() => output).toContain('Approval required');
    expect(approvalPayloads).toEqual([]);
    stdin.write('\u0019');
    await expect
      .poll(() => approvalPayloads)
      .toEqual([{ payloadHash: 'exact-test-hash', scope: 'once' }]);
    await expect.poll(() => output).toContain('Action approved');
    await command('/schedule');
    await expect.poll(() => output).toContain('Automation name');
    stdin.write('Wizard test');
    await expect.poll(() => output).toContain('Wizard test');
    stdin.write('\r');
    await expect.poll(() => output).toContain('Schedule type');
    stdin.write('\r');
    await expect.poll(() => output).toContain('Schedule expression');
    stdin.write('\r');
    await expect.poll(() => output).toContain('Agent instructions');
    stdin.write('Check the shipment | keep this pipe');
    await expect.poll(() => output).toContain('Check the shipment | keep this pipe');
    stdin.write('\r');
    await expect.poll(() => output).toContain('Review automation');
    expect(createdSchedules).toEqual([]);
    stdin.write('Save automation');
    await expect.poll(() => output).toContain('Search: Save automation');
    stdin.write('\r');
    await expect.poll(() => createdSchedules).toHaveLength(1);
    expect(createdSchedules[0]).toMatchObject({
      name: 'Wizard test',
      type: 'manual',
      expression: 'manual',
      agentInput: 'Check the shipment | keep this pipe',
      enabled: true,
    });
    await expect.poll(() => output).toContain('Automation saved and verified');
  } finally {
    app.unmount();
    app.cleanup();
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
