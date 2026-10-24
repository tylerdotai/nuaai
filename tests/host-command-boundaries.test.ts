import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { identityHarness } from './identity.harness.js';

it('bounds timeout/output, reports missing executables, and honors cancellation in the real subprocess boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-host-boundary-'));
  const tools = new ToolRegistry(root);
  const context = { root, permissions: permissionContextForProfile('operator') };
  await expect(
    tools.execute('host.command', { command: 'nuaai-nonexistent-fixture-executable' }, context),
  ).rejects.toThrow('Executable not found');
  await expect(tools.execute('host.command', { command: '\0' }, context)).rejects.toThrow(
    'literal executable',
  );
  await expect(
    tools.execute(
      'host.command',
      { command: process.execPath, args: ['-e', 'setTimeout(()=>{},5000)'], timeoutMs: 100 },
      context,
    ),
  ).rejects.toThrow('Do not retry automatically');
  await expect(
    tools.execute(
      'host.command',
      { command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(300000))'] },
      context,
    ),
  ).rejects.toThrow('output limit exceeded');
  const controller = new AbortController();
  const pending = tools.execute(
    'host.command',
    { command: process.execPath, args: ['-e', 'setTimeout(()=>{},5000)'] },
    { ...context, signal: controller.signal },
  );
  const rejected = expect(pending).rejects.toThrow('FIXTURE_CANCELLED');
  controller.abort(new Error('FIXTURE_CANCELLED'));
  await rejected;
});

it('reuses only the reviewed exact host invocation for the session, and Unguarded executes a new invocation without prompting', async () => {
  const h = await identityHarness();
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    const current = request.messages
      .map((m) => m.role === 'user' && m.content.startsWith('Run HOST'))
      .lastIndexOf(true);
    const results = request.messages.slice(current + 1).filter((m) => m.role === 'tool');
    if (!results.length)
      yield {
        type: 'tool_call',
        id: 'host',
        name: 'host.command',
        arguments: {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("HOST_SESSION")'],
          stdin: request.messages[current].content.includes('different') ? 'different' : 'same',
        },
      };
    else yield { type: 'done', text: 'Host command result verified.' };
  });
  try {
    const session = h.daemon.runtime.createSession(
      'Host session grant',
      'test:host-session',
      undefined,
      { workspaceRoot: h.project },
    );
    const start = async (input: string) =>
      (await h.api('/api/runs', { threadId: session.thread.id, input })).body.id;
    const first = await start('Run HOST CLI command.');
    await expect.poll(() => h.daemon.runtime.listApprovals('pending').length).toBe(1);
    let approval = h.daemon.runtime.listApprovals('pending')[0];
    await h.api(`/api/approvals/${approval.id}/approve`, {
      payloadHash: approval.payloadHash,
      scope: 'session',
    });
    expect((await h.daemon.runtime.waitForRun(first)).status).toBe('completed');
    expect(
      (await h.daemon.runtime.waitForRun(await start('Run HOST CLI command again.'))).status,
    ).toBe('completed');
    const changed = await start('Run HOST CLI command with different stdin.');
    await expect.poll(() => h.daemon.runtime.listApprovals('pending').length).toBe(1);
    approval = h.daemon.runtime.listApprovals('pending')[0];
    await h.api(`/api/approvals/${approval.id}/deny`, { payloadHash: approval.payloadHash });
    expect((await h.daemon.runtime.waitForRun(changed)).status).toBe('failed');
    await h.api(`/api/sessions/${session.session.id}/permissions`, {
      mode: 'unguarded',
      confirmUnguarded: true,
    });
    expect(
      (
        await h.daemon.runtime.waitForRun(
          await start('Run HOST CLI command with different stdin now.'),
        )
      ).status,
    ).toBe('completed');
    expect(h.daemon.runtime.listApprovals('pending')).toEqual([]);
  } finally {
    for (const approval of h.daemon.runtime.listApprovals('pending'))
      h.daemon.runtime.denyApproval(approval.id, approval.payloadHash);
    await h.close();
  }
});
