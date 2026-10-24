import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('corrects an untested CLI refusal by pointing the model at the actual host executor', async () => {
  const h = await identityHarness();
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    if (request.messages.some((m) => m.toolName === 'host.command'))
      yield { type: 'done', text: 'Host CLI execution verified.' };
    else if (request.messages.some((m) => m.role === 'user' && m.content.includes('host.command')))
      yield {
        type: 'tool_call',
        id: 'host-version',
        name: 'host.command',
        arguments: { command: process.execPath, args: ['--version'] },
      };
    else
      yield {
        type: 'done',
        text: 'I cannot run this CLI because workspace.command only allows read-only probes.',
      };
  });
  try {
    const session = h.daemon.runtime.createSession(
      'CLI correction',
      'test:cli-correction',
      undefined,
      { workspaceRoot: h.project },
    );
    const accepted = await h.api('/api/runs', {
      threadId: session.thread.id,
      input: 'Run the installed host CLI version command.',
    });
    await expect.poll(() => h.daemon.runtime.listApprovals('pending').length).toBe(1);
    const approval = h.daemon.runtime.listApprovals('pending')[0];
    await h.api(`/api/approvals/${approval.id}/approve`, { payloadHash: approval.payloadHash });
    const result = await h.daemon.runtime.waitForRun(accepted.body.id);
    expect(result.status, result.output).toBe('completed');
    expect(result.output).toContain('Host CLI execution verified.');
  } finally {
    for (const approval of h.daemon.runtime.listApprovals('pending'))
      h.daemon.runtime.denyApproval(approval.id, approval.payloadHash);
    await h.close();
  }
});

it('reports a real read-only execution restriction without claiming tool registration proves access', async () => {
  const h = await identityHarness(undefined, (config) => {
    config.permissions.web = 'read-only';
  });
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* () {
    yield { type: 'done', text: 'I cannot run the CLI under this read-only profile.' };
  });
  try {
    const session = h.daemon.runtime.createSession('Read only CLI', 'test:cli-readonly');
    const accepted = await h.api('/api/runs', {
      threadId: session.thread.id,
      input: 'Run the Himalaya CLI version command.',
    });
    const result = await h.daemon.runtime.waitForRun(accepted.body.id);
    expect(result.status).toBe('failed');
    expect(result.output).toContain('current permissions');
    expect(result.output).not.toContain('unverified capability claim');
  } finally {
    await h.close();
  }
});
