import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { identityHarness } from './identity.harness.js';

it('executes a host CLI with literal argv/stdin and rejects read-only admission without widening workspace.command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-host-cli-'));
  const tools = new ToolRegistry(root);
  const input = {
    command: process.execPath,
    args: [
      '-e',
      'process.stdin.on("data",x=>process.stdout.write(process.argv[1]+":"+x))',
      'literal; not-a-shell',
    ],
    stdin: 'HOST_CLI_INPUT',
  };
  const result = await tools.execute('host.command', input, {
    root,
    permissions: permissionContextForProfile('operator'),
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: 'literal; not-a-shell:HOST_CLI_INPUT' });
  await expect(
    tools.execute('host.command', input, {
      root,
      permissions: permissionContextForProfile('read-only'),
    }),
  ).rejects.toThrow(/permission/i);
  await expect(
    tools.execute(
      'workspace.command',
      { command: process.execPath, args: ['--version'] },
      { root, permissions: permissionContextForProfile('operator') },
    ),
  ).rejects.toThrow(/allowlisted/i);
});

it('puts a host CLI behind exact approval and refuses to silently retry a possibly partial failure', async () => {
  const h = await identityHarness();
  let calls = 0;
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (!request.messages.some((m) => m.role === 'tool')) {
      calls++;
      yield {
        type: 'tool_call',
        id: 'host-cli',
        name: 'host.command',
        arguments: {
          command: process.execPath,
          args: ['-e', 'console.log("HOST_STARTED");process.exit(3)'],
        },
      };
    } else yield { type: 'done', text: 'No successful result.' };
  });
  try {
    const session = h.daemon.runtime.createSession(
      'Host command approval',
      'test:host-approval',
      undefined,
      { workspaceRoot: h.project },
    );
    const accepted = await h.api('/api/runs', {
      threadId: session.thread.id,
      input: 'Run the host CLI command.',
    });
    await expect
      .poll(
        () =>
          h.daemon.runtime.listApprovals('pending').find((a) => a.runId === accepted.body.id)
            ?.toolName,
      )
      .toBe('host.command');
    const approval = h.daemon.runtime.listApprovals('pending')[0];
    expect(approval.preview.fields.map((field) => field.label)).toContain('Command (transient)');
    await h.api(`/api/approvals/${approval.id}/approve`, { payloadHash: approval.payloadHash });
    const result = await h.daemon.runtime.waitForRun(accepted.body.id);
    expect(result.status).toBe('failed');
    expect(result.output).toContain('Do not retry automatically');
    expect(calls).toBe(1);
  } finally {
    for (const approval of h.daemon.runtime.listApprovals('pending'))
      h.daemon.runtime.denyApproval(approval.id, approval.payloadHash);
    await h.close();
  }
});
