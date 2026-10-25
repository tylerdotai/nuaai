import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeVoiceProvider } from '../src/voice/native-provider.js';
import { identityHarness } from './identity.harness.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(
  profile = 'subscription-webrtc-v3',
  failure = '',
  hang = false,
  diagnostic = false,
  exitCode = 0,
) {
  const root = mkdtempSync(join(tmpdir(), 'nuaai-live-host-test-'));
  roots.push(root);
  const binary = join(root, 'helper');
  const temporaryRoot = join(root, 'children');
  mkdirSync(temporaryRoot, { mode: 0o700 });
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs=require('node:fs');
process.exitCode=${exitCode};
fs.writeFileSync(${JSON.stringify(join(root, 'pid'))},String(process.pid),{mode:0o600});
if(${JSON.stringify(hang)}){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
if(![0,1,2].every(fd=>fs.fstatSync(fd).isFIFO()))process.exit(7);
if(Object.keys(process.env).some(key=>!['HOME','CODEX_HOME','PATH','LANG','TZ'].includes(key)))process.exit(8);
let bytes=Buffer.alloc(0);
const send=m=>{const b=Buffer.from(JSON.stringify({v:1,...m}));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]));};
process.stdin.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);while(bytes.length>=4&&bytes.length>=4+bytes.readUInt32BE()){
const length=bytes.readUInt32BE();const m=JSON.parse(bytes.subarray(4,4+length));bytes=bytes.subarray(4+length);
if(m.type==='hello')send({type:'hello',commandId:m.commandId,profile:${JSON.stringify(profile)},interruption:'unsupported'});
if(m.type==='start'){
if(${JSON.stringify(diagnostic)})process.stderr.write(${JSON.stringify('unapproved synthetic-private\nNUAAI_VOICE_DIAGNOSTIC operation=call kind=http status=403\nNUAAI_VOICE_DIAGNOSTIC operation=call kind=http status=403 token=synthetic-private\n')});
if(${JSON.stringify(failure)}){process.stderr.write('synthetic-private-diagnostic\\n');send({type:'error',commandId:m.commandId,code:${JSON.stringify(failure)}});process.stdin.destroy();process.stdout.end();process.stderr.end();}
else {send({type:'answer',commandId:m.commandId,sdp:'synthetic-answer'});send({type:'control_ready',commandId:m.commandId});send({type:'handoff',handoffId:'h',text:'task'});send({type:'transcript',itemId:'u',role:'user',text:'transcript-not-task',status:'final'});}}
if(m.type==='append'){fs.appendFileSync(${JSON.stringify(join(root, 'appends.jsonl'))},JSON.stringify(m)+'\\n',{mode:0o600});send({type:'delivery',commandId:m.commandId,handoffId:m.handoffId,deliveryId:m.deliveryId,status:'accepted'});}
if(m.type==='close'&&!${JSON.stringify(hang)}){send({type:'closed',commandId:m.commandId});process.stdin.destroy();process.stdout.end();process.stderr.end();}
}});
`,
    { mode: 0o700 },
  );
  return {
    root,
    binary,
    temporaryRoot,
    home,
    provider: (logger?: Pick<Console, 'warn'>) =>
      createNativeVoiceProvider(binary, { temporaryRoot, home, logger }),
  };
}

describe('trusted native voice provider and actual owned FIFO host', () => {
  it('keeps missing/unsafe/symlink/non-executable helpers unavailable without spawning', () => {
    expect(createNativeVoiceProvider(undefined).availability().available).toBe(false);
    const f = fixture();
    const provider = f.provider();
    expect(provider.availability().available).toBe(true);
    chmodSync(f.binary, 0o722);
    expect(() => provider.create()).toThrow(/VOICE_CODEX_UNAVAILABLE/);
    expect(f.provider().availability().available).toBe(false);
    expect(() => f.provider().create()).toThrow(/VOICE_CODEX_UNAVAILABLE/);
    chmodSync(f.binary, 0o600);
    expect(f.provider().availability().available).toBe(false);
    chmodSync(f.binary, 0o700);
    const link = join(f.root, 'link');
    symlinkSync(f.binary, link);
    expect(createNativeVoiceProvider(link).availability().available).toBe(false);
    expect(createNativeVoiceProvider('relative-helper').availability().available).toBe(false);
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  });
  it('uses private FIFO integer stdio, clean environment, coalesced live events and cleanup', async () => {
    const f = fixture();
    const provider = f.provider();
    expect(provider.availability()).toEqual({
      available: true,
      taskMode: 'daemon',
      interruption: 'unsupported',
    });
    const transport = provider.create();
    const [childDirectory] = readdirSync(f.temporaryRoot);
    const dir = join(f.temporaryRoot, childDirectory);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    for (const name of ['stdin', 'stdout', 'stderr']) {
      const metadata = lstatSync(join(dir, name));
      expect(metadata.isFIFO()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o600);
    }
    const events: unknown[] = [];
    try {
      expect(
        await transport.start(
          'synthetic-offer',
          (event) => events.push(event),
          new AbortController().signal,
        ),
      ).toBe('synthetic-answer');
      transport.acceptAnswer?.();
      await vi.waitFor(() => {
        expect(events).toContainEqual({ type: 'handoff', handoffId: 'h', text: 'task' });
        expect(events).toContainEqual({
          type: 'transcript',
          itemId: 'u',
          role: 'user',
          text: 'transcript-not-task',
          final: true,
        });
      });
      await transport.deliver('authoritative result', { handoffId: 'h', deliveryId: 'd' });
      await transport.stop();
      await transport.stop();
      expect(readdirSync(f.temporaryRoot)).toEqual([]);
    } finally {
      await transport.stop();
    }
  });
  it.each(['VOICE_CODEX_LOGIN_REQUIRED', 'VOICE_SUBSCRIPTION_REQUIRED', 'VOICE_QUOTA_EXCEEDED'])(
    'surfaces %s and removes the owned child directory',
    async (code) => {
      const f = fixture('subscription-webrtc-v3', code);
      const transport = f.provider().create();
      await expect(
        transport.start('synthetic-offer', () => {}, new AbortController().signal),
      ).rejects.toMatchObject({ code });
      await transport.stop();
      expect(readdirSync(f.temporaryRoot)).toEqual([]);
      expect(readFileSync(f.binary, 'utf8')).not.toContain('auth.json');
    },
  );
  it('logs only parsed safe diagnostic fields from owned helper stderr', async () => {
    const f = fixture('subscription-webrtc-v3', 'VOICE_ACCESS_DENIED', false, true);
    const warn = vi.fn();
    const transport = f.provider({ warn }).create();
    await expect(
      transport.start('offer', () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'VOICE_ACCESS_DENIED' });
    await transport.stop();
    expect(warn).toHaveBeenCalledExactlyOnceWith('NUAAI native voice operation failed', {
      operation: 'call',
      kind: 'http',
      status: 403,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-private');
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  });
  it('logs only the numeric nonzero exit classification, never raw panic-like stderr', async () => {
    const f = fixture('subscription-webrtc-v3', 'VOICE_PROVIDER_ERROR', false, false, 101);
    const warn = vi.fn();
    const transport = f.provider({ warn }).create();
    await expect(
      transport.start('offer', () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'VOICE_PROVIDER_ERROR' });
    await transport.stop();
    expect(warn).toHaveBeenCalledExactlyOnceWith('NUAAI native voice helper exited', {
      code: 101,
      signal: null,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-private');
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  });
  it('hosts two concurrent FIFO children without thread-pool stalls or cross-generation events', async () => {
    const f = fixture();
    const provider = f.provider();
    const a = provider.create();
    const b = provider.create();
    try {
      expect(readdirSync(f.temporaryRoot)).toHaveLength(2);
      expect(
        await Promise.all([
          a.start('A', () => {}, new AbortController().signal),
          b.start('B', () => {}, new AbortController().signal),
        ]),
      ).toEqual(['synthetic-answer', 'synthetic-answer']);
      a.acceptAnswer?.();
      b.acceptAnswer?.();
      await Promise.all([a.stop(), b.stop()]);
      expect(readdirSync(f.temporaryRoot)).toEqual([]);
    } finally {
      await Promise.allSettled([a.stop(), b.stop()]);
    }
  });
  it('bounds shutdown of an unresponsive owned helper, kills it and removes all FIFOs', async () => {
    const f = fixture('subscription-webrtc-v3', '', true);
    const transport = f.provider().create();
    expect(await transport.start('offer', () => {}, new AbortController().signal)).toBe(
      'synthetic-answer',
    );
    transport.acceptAnswer?.();
    const pid = Number(readFileSync(join(f.root, 'pid'), 'utf8'));
    await expect(transport.stop()).rejects.toMatchObject({ code: 'VOICE_CLEANUP_FAILED' });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  });
  it('real daemon uses only trusted operator helper selection and admits handoffs, not transcripts', async () => {
    const f = fixture();
    vi.stubEnv('HOME', f.home);
    vi.stubEnv('NUAAI_VOICE_HELPER', f.binary);
    const h = await identityHarness();
    try {
      expect(
        (await fetch(`http://127.0.0.1:${h.daemon.gateway.port}/api/voice/capabilities`)).status,
      ).toBe(401);
      expect((await h.api('/api/voice/capabilities')).body).toMatchObject({
        available: true,
        taskMode: 'daemon',
        interruption: 'unsupported',
      });
      const session = await h.api('/api/sessions', {
        title: 'Synthetic live-profile host',
        workspaceRoot: h.project,
      });
      const request = {
        sessionId: session.body.session.id,
        threadId: session.body.thread.id,
        requestId: 'voice',
        offer: { type: 'offer', sdp: 'synthetic-offer' },
      };
      expect((await h.api('/api/voice/sessions', { ...request, helper: f.binary })).status).toBe(
        400,
      );
      const started = await h.api('/api/voice/sessions', request);
      expect(started.status).toBe(201);
      expect(started.body.answer.sdp).toBe('synthetic-answer');
      await vi.waitFor(() => expect(h.daemon.store.listRuns(request.threadId)).toHaveLength(1));
      const [run] = h.daemon.store.listRuns(request.threadId);
      expect(run.input).toBe('task');
      expect((await h.daemon.runtime.waitForRun(run.id)).status).toBe('completed');
      expect(h.daemon.store.getRunExecutionContext(run.id)?.permissionSource).toBe('web');
      const stopped = await h.api(`/api/voice/sessions/${started.body.voice.id}/stop`, {
        generation: started.body.voice.generation,
        reason: 'hangup',
      });
      expect(stopped.body.phase).toBe('closed');
      expect(h.daemon.store.listRuns(request.threadId)).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
  it.each(['failed', 'cancelled', 'hangup', 'revoked', 'unconfirmed'] as const)(
    'real daemon delivers only the correlated safe %s outcome, never failed output or late speech',
    async (mode) => {
      const f = fixture();
      vi.stubEnv('HOME', f.home);
      vi.stubEnv('NUAAI_VOICE_HELPER', f.binary);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = await identityHarness(async () => {
        await held;
        throw new Error('synthetic-private-provider-failure');
      });
      let waiting: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const session = await h.api('/api/sessions', {
          title: 'Terminal outcome',
          workspaceRoot: h.project,
        });
        if (mode === 'unconfirmed')
          waiting = vi
            .spyOn(h.daemon.runtime, 'waitForRun')
            .mockRejectedValueOnce(new Error('synthetic-private-observer-failure'));
        const started = await h.api('/api/voice/sessions', {
          sessionId: session.body.session.id,
          threadId: session.body.thread.id,
          requestId: 'terminal',
          offer: { type: 'offer', sdp: 'synthetic-offer' },
        });
        expect(started.status).toBe(201);
        await vi.waitFor(() =>
          expect(h.daemon.store.listRuns(session.body.thread.id)).toHaveLength(1),
        );
        const [run] = h.daemon.store.listRuns(session.body.thread.id);
        waiting?.mockRestore();
        waiting = undefined;
        if (mode === 'cancelled') h.daemon.runtime.cancelRun(run.id);
        if (mode === 'hangup') {
          expect(
            (
              await h.api(`/api/voice/sessions/${started.body.voice.id}/stop`, {
                generation: started.body.voice.generation,
                reason: 'hangup',
              })
            ).status,
          ).toBe(200);
          expect(h.daemon.store.getRun(run.id)?.cancelRequested).toBe(false);
        }
        if (mode === 'revoked')
          expect(
            (await h.api(`/api/sessions/${session.body.session.id}/identity/refresh`, {})).status,
          ).toBe(200);
        release();
        const terminal = await h.daemon.runtime.waitForRun(run.id);
        expect(terminal.status).toBe(mode === 'cancelled' ? 'cancelled' : 'failed');
        expect(h.daemon.store.getRunExecutionContext(run.id)?.permissionSource).toBe('web');
        const file = join(f.root, 'appends.jsonl');
        if (mode === 'hangup' || mode === 'revoked') {
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(existsSync(file)).toBe(false);
          expect(h.daemon.store.listRuns(session.body.thread.id)).toHaveLength(1);
          return;
        }
        await vi.waitFor(() => expect(existsSync(file)).toBe(true));
        const appends = readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map(
            (line) => JSON.parse(line) as { handoffId: string; deliveryId: string; text: string },
          );
        expect(appends).toHaveLength(1);
        expect(appends[0].handoffId).toBe('h');
        expect(appends[0].text).toBe(
          mode === 'failed'
            ? 'The delegated task failed. No completed result is available.'
            : mode === 'cancelled'
              ? 'The delegated task was cancelled. No completed result is available.'
              : 'The delegated task result could not be confirmed. Do not report it as completed.',
        );
        expect(JSON.stringify(appends)).not.toContain('synthetic-private');
        await h.api(`/api/voice/sessions/${started.body.voice.id}/stop`, {
          generation: started.body.voice.generation,
          reason: 'hangup',
        });
        const response = await fetch(
          `http://127.0.0.1:${h.daemon.gateway.port}/api/voice/sessions/${started.body.voice.id}/events`,
          {
            headers: { authorization: `Bearer ${h.daemon.token}` },
            signal: AbortSignal.timeout(2000),
          },
        );
        const events = [...(await response.text()).matchAll(/^data: (.*)$/gm)].map((match) =>
          JSON.parse(match[1]),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'voice.run.linked',
            payload: { runId: run.id, handoffId: 'h' },
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'voice.result.delivery',
            payload: { runId: run.id, deliveryId: appends[0].deliveryId, status: 'accepted' },
          }),
        );
        expect(h.daemon.store.getRun(run.id)?.status).toBe(terminal.status);
        expect(h.daemon.store.listRuns(session.body.thread.id)).toHaveLength(1);
      } finally {
        waiting?.mockRestore();
        release();
        await h.close();
      }
    },
  );
  it('real daemon returns structured managed-login failure without leaking helper diagnostics', async () => {
    const f = fixture('subscription-webrtc-v3', 'VOICE_CODEX_LOGIN_REQUIRED');
    vi.stubEnv('HOME', f.home);
    vi.stubEnv('NUAAI_VOICE_HELPER', f.binary);
    const h = await identityHarness();
    try {
      const session = await h.api('/api/sessions', {
        title: 'Synthetic missing login',
        workspaceRoot: h.project,
      });
      const result = await h.api('/api/voice/sessions', {
        sessionId: session.body.session.id,
        threadId: session.body.thread.id,
        requestId: 'login',
        offer: { type: 'offer', sdp: 'synthetic-offer' },
      });
      expect(result.status).toBe(502);
      expect(result.body.error).toMatchObject({
        code: 'VOICE_CODEX_LOGIN_REQUIRED',
        retryable: false,
      });
      expect(JSON.stringify(result.body)).not.toContain(f.binary);
      expect(JSON.stringify(result.body)).not.toContain('synthetic-private-diagnostic');
      expect(h.daemon.store.listRuns(session.body.thread.id)).toEqual([]);
    } finally {
      await h.close();
    }
  });
  it('rejects an offline helper presented as installed live voice and cleans its process', async () => {
    const f = fixture('offline-memory-v1');
    const transport = f.provider().create();
    await expect(
      transport.start('synthetic-offer', () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    await transport.stop();
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  });
});
