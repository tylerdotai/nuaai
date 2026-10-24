import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { realTuiHarness } from './tui.real-harness.js';

it('changes modes with confirmation and grants only the visible reviewed action for the session through real TUI keys', async () => {
  const h = await realTuiHarness();
  try {
    await h.command('/permissions', 'Approval mode');
    expect(h.frame()).toContain('Manual');
    expect(h.frame()).toContain('Smart');
    expect(h.frame()).toContain('Unguarded');
    await h.send('Smart');
    await h.send('\r', 'Approval mode · smart');
    await h.command('/permissions unguarded', 'Enable Unguarded mode?');
    const sessionId = h.daemon.store
      .listSessions()
      .find((session) => h.daemon.runtime.sessionApprovalPolicy(session.id).mode === 'smart')?.id;
    expect(sessionId).toBeTruthy();
    expect((await h.api(`/api/sessions/${sessionId}/permissions`)).body.mode).toBe('smart');
    await h.send('\u001b[B');
    await h.send('\r', 'Approval mode · unguarded');
    expect((await h.api(`/api/sessions/${sessionId}/permissions`)).body.mode).toBe('unguarded');
    await h.command('/permissions manual', 'Approval mode · manual');
    vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
      const current = request.messages
        .map((m) => m.role === 'user' && m.content.startsWith('Write TUI'))
        .lastIndexOf(true);
      const results = request.messages.slice(current + 1).filter((m) => m.role === 'tool');
      if (!results.length)
        yield {
          type: 'tool_call',
          id: 'write',
          name: 'workspace.write',
          arguments: { path: 'tui-policy.txt', content: 'TUI_POLICY_BYTES' },
        };
      else if (results.length === 1)
        yield {
          type: 'tool_call',
          id: 'read',
          name: 'workspace.read',
          arguments: { path: 'tui-policy.txt' },
        };
      else yield { type: 'done', text: 'TUI write verified.' };
    });
    await h.command('Write TUI file tui-policy.txt.', 'Approval required');
    expect(h.frame()).toContain('Alt-G session');
    await h.send('\u001bg', 'TUI write verified.');
    const policy = (await h.api(`/api/sessions/${sessionId}/permissions`)).body;
    expect(policy.grants).toMatchObject([{ tool: 'workspace.write', target: 'tui-policy.txt' }]);
    await h.command('/permissions reset', 'Session grants revoked');
    expect((await h.api(`/api/sessions/${sessionId}/permissions`)).body.grants).toEqual([]);
  } finally {
    await h.close();
  }
}, 30000);
