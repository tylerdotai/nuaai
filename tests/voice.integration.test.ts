import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createToken } from '../src/gateway/token.js';
import {
  CodexVoiceTransport,
  createCodexStdioWire,
  unsupportedCodexVoiceProvider,
} from '../src/voice/codex-transport.js';
import { identityHarness } from './identity.harness.js';

describe('voice real local boundaries (never installed Codex)', () => {
  it('keeps real daemon capabilities authenticated and unavailable without creating provider work', async () => {
    const h = await identityHarness();
    const create = vi.spyOn(unsupportedCodexVoiceProvider, 'create');
    try {
      const capability = await h.api('/api/voice/capabilities');
      expect(capability.status).toBe(200);
      expect(capability.body).toMatchObject({
        available: false,
        taskMode: 'disabled',
        interruption: 'unsupported',
        blockers: [{ code: 'VOICE_EXECUTION_ISOLATION_UNVERIFIED' }],
      });
      const admitted = await h.api('/api/voice/sessions', {
        sessionId: 's1',
        threadId: 't1',
        requestId: 'r1',
        offer: { type: 'offer', sdp: 'negotiation-private' },
      });
      expect(admitted.status).toBe(503);
      expect(create).not.toHaveBeenCalled();
      expect(h.observed).toHaveLength(0);
      const url = `http://127.0.0.1:${h.daemon.gateway.port}`;
      for (const path of ['/api/voice/capabilities', '/api/voice/sessions/missing/events']) {
        const response = await fetch(`${url}${path}`);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          code: 'AUTH_REQUIRED',
          error: expect.any(String),
        });
      }
      const expired = createToken({ sub: 'test', exp: 1 }, 'synthetic-not-daemon-secret', 0);
      const rejected = await fetch(`${url}/api/voice/capabilities`, {
        headers: { authorization: `Bearer ${expired}` },
      });
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
      const existing = await h.api('/api/sessions', { title: 'Text still works' });
      await h.run(existing.body.thread.id);
    } finally {
      create.mockRestore();
      await h.close();
    }
  }, 15_000);

  it('negotiates JSON-RPC over an isolated fake subprocess and reaps it on stop without key inheritance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-voice-rpc-'));
    const executable = join(root, 'fake-codex.mjs');
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
 const message = JSON.parse(line);
 if (!message.id || !message.method) return;
 if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.NUAAI_VOICE_PRIVATE_SENTINEL) {
   send({id:message.id,error:{code:-32602,message:'unexpected environment'}}); return;
 }
 let result = {};
 if (message.method === 'account/read') result = {account:{type:'chatgpt'}};
 if (message.method === 'thread/start') result = {thread:{id:'isolated-backing'}};
 if (message.method === 'thread/realtime/start') {
   send({method:'thread/realtime/started',params:{threadId:'isolated-backing',version:'v3'}});
   send({method:'thread/realtime/sdp',params:{threadId:'isolated-backing',sdp:'fixture-answer'}});
 }
 send({id:message.id,result});
});
`,
    );
    await chmod(executable, 0o755);
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-must-not-inherit');
    vi.stubEnv('CODEX_API_KEY', 'synthetic-must-not-inherit');
    vi.stubEnv('NUAAI_VOICE_PRIVATE_SENTINEL', 'synthetic-must-not-inherit');
    const transport = new CodexVoiceTransport(createCodexStdioWire(executable, root, root));
    try {
      expect(await transport.start('fixture-offer', () => {}, new AbortController().signal)).toBe(
        'fixture-answer',
      );
      await transport.deliver('Verified fixture result');
      await transport.stop();
      await transport.stop();
      await expect(transport.deliver('late delivery')).rejects.toMatchObject({
        code: 'VOICE_PROVIDER_DISCONNECTED',
      });
    } finally {
      await transport.stop();
      vi.unstubAllEnvs();
    }
  });
});
