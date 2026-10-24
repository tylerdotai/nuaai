import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('enforces manual, bounded session grants, confirmed unguarded, and protected paths through authenticated daemon routes', async () => {
  const h = await identityHarness();
  let seen: unknown;
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    seen = request.messages.slice(-5);
    const lastUser = request.messages
      .map((message) => message.role === 'user' && message.content.startsWith('Write '))
      .lastIndexOf(true);
    const input = request.messages[lastUser]?.content ?? '';
    const path = input.includes('protected') ? '.env' : 'approved.txt';
    const tools = request.messages.slice(lastUser + 1).filter((message) => message.role === 'tool');
    if (!tools.length)
      yield {
        type: 'tool_call',
        id: 'write',
        name: 'workspace.write',
        arguments: { path, content: input },
      };
    else if (tools.length === 1)
      yield { type: 'tool_call', id: 'read', name: 'workspace.read', arguments: { path } };
    else yield { type: 'done', text: 'File write verified.' };
  });
  const start = async (threadId: string, input: string) => {
    const response = await h.api('/api/runs', { threadId, input });
    expect(response.status).toBe(200);
    return response.body.id as string;
  };
  const pending = async (runId: string) => {
    await expect
      .poll(() => h.daemon.runtime.listApprovals('pending').find((item) => item.runId === runId))
      .toBeTruthy();
    const approval = h.daemon.runtime.listApprovals('pending').find((item) => item.runId === runId);
    if (!approval) throw new Error('Expected pending approval');
    return approval;
  };
  try {
    const first = h.daemon.runtime.createSession('Policy A', 'test:policy-a', undefined, {
      workspaceRoot: h.project,
    });
    const route = `/api/sessions/${first.session.id}/permissions`;
    expect((await h.api(route)).body.mode).toBe('manual');
    const run = await start(first.thread.id, 'Write approved.txt with first content.');
    const approval = await pending(run);
    expect(
      (
        await h.api(`/api/approvals/${approval.id}/approve`, {
          payloadHash: approval.payloadHash,
          scope: 'session',
        })
      ).status,
    ).toBe(200);
    expect((await h.daemon.runtime.waitForRun(run)).status).toBe('completed');
    const retry = await start(first.thread.id, 'Write approved.txt with different content.');
    expect((await h.daemon.runtime.waitForRun(retry)).status).toBe('completed');
    expect(await readFile(join(h.project, 'approved.txt'), 'utf8')).toContain('different content');
    expect((await h.api(route)).body.grants).toHaveLength(1);
    await h.restart();
    expect((await h.api(route)).body.grants).toHaveLength(1);
    const other = h.daemon.runtime.createSession('Policy B', 'test:policy-b', undefined, {
      workspaceRoot: h.project,
    });
    const otherRun = await start(other.thread.id, 'Write approved.txt in another session.');
    const otherApproval = await pending(otherRun);
    await h.api(`/api/approvals/${otherApproval.id}/deny`, {
      payloadHash: otherApproval.payloadHash,
    });
    expect((await h.daemon.runtime.waitForRun(otherRun)).status).toBe('failed');
    expect((await h.api(route, { mode: 'unguarded' })).status).toBe(400);
    expect((await h.api(route, { mode: 'unguarded', confirmUnguarded: true })).body.mode).toBe(
      'unguarded',
    );
    const free = await start(first.thread.id, 'Write approved.txt without an approval prompt.');
    expect((await h.daemon.runtime.waitForRun(free)).status).toBe('completed');
    const blocked = await start(first.thread.id, 'Write protected .env file.');
    const blockedResult = await h.daemon.runtime.waitForRun(blocked);
    expect(blockedResult.status, JSON.stringify({ blockedResult, observed: seen })).toBe('failed');
    expect((await h.api(route, { mode: 'manual', revokeGrants: true })).body.grants).toEqual([]);
    expect((await h.api(`/api/sessions/${other.session.id}/permissions`)).body.mode).toBe('manual');
  } finally {
    await h.close();
  }
}, 20000);
