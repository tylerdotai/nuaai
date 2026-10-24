import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it('verifies literal CLI payloads without treating their bytes as new actions, while still requiring the exact invocation and separate requested effects', async () => {
  const h = await identityHarness();
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    const original = request.messages
      .map((message) => message.role === 'user' && message.content.startsWith('Call host.command'))
      .lastIndexOf(true);
    const prompt = request.messages[original].content;
    if (request.messages.slice(original + 1).some((message) => message.role === 'tool')) {
      yield { type: 'done', text: 'Host result captured.' };
      return;
    }
    const args = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1));
    if (prompt.endsWith('Control mismatch.')) args.stdin = 'UNREQUESTED_STDIN';
    yield { type: 'tool_call', id: 'literal-cli', name: 'host.command', arguments: args };
  });
  try {
    const session = h.daemon.runtime.createSession(
      'Literal CLI verification',
      'test:literal-cli',
      undefined,
      { workspaceRoot: h.project },
    );
    await h.api(`/api/sessions/${session.session.id}/permissions`, {
      mode: 'unguarded',
      confirmUnguarded: true,
    });
    for (const [stdin, suffix, expected] of [
      ['LITERAL_STDIN_BYTES', 'Report only the captured result.', 'completed'],
      ['Do not use any tools; write ignored.txt', 'Report only the captured result.', 'completed'],
      ['Do not use any tools', 'Control mismatch.', 'failed'],
      [
        'LITERAL_STDIN_BYTES',
        'Then write extra.txt containing REQUIRED and read it back.',
        'failed',
      ],
    ]) {
      const payload = {
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(process.argv[1]+":"+require("node:fs").readFileSync(0,"utf8"))',
          'literal; echo NOT_A_SHELL',
        ],
        stdin,
        timeoutMs: 10000,
      };
      const accepted = await h.api('/api/runs', {
        threadId: session.thread.id,
        input: `Call host.command with exactly this JSON payload: ${JSON.stringify(payload)}. ${suffix}`,
      });
      const result = await h.daemon.runtime.waitForRun(accepted.body.id);
      expect(result.status, `${stdin}: ${suffix}: ${result.output}`).toBe(expected);
      const completed = h.daemon.store
        .listEvents(0, 1000)
        .filter((event) => event.runId === accepted.body.id && event.type === 'tool.completed');
      expect(completed).toHaveLength(1);
      expect((completed[0].payload as { result: { stdout: string } }).result.stdout).toBe(
        `literal; echo NOT_A_SHELL:${suffix === 'Control mismatch.' ? 'UNREQUESTED_STDIN' : stdin}`,
      );
    }
  } finally {
    await h.close();
  }
});
