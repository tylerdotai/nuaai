import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VoiceBroker,
  VoiceError,
  type VoiceProviderEvent,
  type VoiceTransport,
} from '../src/voice/broker.js';
import { type VoiceTaskMode, voiceLimits } from '../src/voice/types.js';

function fixture(taskMode: VoiceTaskMode = 'daemon') {
  let receive: (event: VoiceProviderEvent) => void = () => {};
  let id = 0;
  let authority = 'web';
  const transport: VoiceTransport = {
    start: vi.fn(async (_offer, listener) => {
      receive = listener;
      return 'answer';
    }),
    stop: vi.fn(async () => {}),
    deliver: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
  };
  const admit = vi.fn(() => ({ runId: 'run-1', result: Promise.resolve('verified') }));
  const provider = {
    availability: () => ({ available: true, taskMode, interruption: 'provider' as const }),
    create: vi.fn(() => transport),
  };
  const broker = new VoiceBroker({
    provider,
    authorize: () => ({
      identitySnapshotId: 'i1',
      workspaceRoot: '/fixture',
      authorityKey: authority,
    }),
    admit,
    now: () => Date.now(),
    id: () => `v${++id}`,
  });
  const request = {
    sessionId: 's1',
    threadId: 't1',
    requestId: 'r1',
    offer: { type: 'offer' as const, sdp: 'offer' },
  };
  return {
    broker,
    provider,
    transport,
    admit,
    request,
    event: (event: VoiceProviderEvent) => receive(event),
    revoke: () => {
      authority = 'revoked';
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => vi.useRealTimers());

describe('voice broker fault and evidence boundaries', () => {
  it('rejects invalid input/expired authority and bounds concurrent sessions without creation', async () => {
    const f = fixture();
    await expect(f.broker.start('owner', { ...f.request, threadId: '' })).rejects.toMatchObject({
      code: 'VOICE_INVALID_REQUEST',
    });
    await expect(f.broker.start('owner', f.request, 999)).rejects.toMatchObject({
      code: 'VOICE_FORBIDDEN',
    });
    const first = await f.broker.start('owner', f.request);
    await expect(f.broker.start('owner', { ...f.request, requestId: 'r2' })).rejects.toMatchObject({
      code: 'VOICE_BUSY',
    });
    await f.broker.start('owner2', { ...f.request, threadId: 't2' });
    await expect(f.broker.start('owner3', { ...f.request, threadId: 't3' })).rejects.toMatchObject({
      code: 'VOICE_BUSY',
    });
    expect(f.provider.create).toHaveBeenCalledTimes(2);
    expect(() => f.broker.get('owner', 'missing')).toThrow('VOICE_NOT_FOUND');
    expect(() => f.broker.events('owner', first.voice.id, -1)).toThrow('VOICE_INVALID_REQUEST');
    expect(f.broker.events('owner', first.voice.id, 999)).toMatchObject([{ type: 'voice.resync' }]);
    await f.broker.shutdown();
    expect(f.broker.capabilities().available).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('shares concurrent pending start and never restarts after lost negotiation replay window', async () => {
    const f = fixture();
    let resolve!: (answer: string) => void;
    vi.mocked(f.transport.start).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = f.broker.start('owner', f.request);
    const second = f.broker.start('owner', f.request);
    resolve('answer');
    expect(await first).toEqual(await second);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(f.broker.start('owner', f.request)).rejects.toMatchObject({
      code: 'VOICE_NEGOTIATION_EXPIRED',
    });
    expect(f.transport.start).toHaveBeenCalledOnce();
    await f.broker.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not let a browser connected observation authorize pre-negotiation handoffs', async () => {
    const f = fixture();
    let event!: (value: VoiceProviderEvent) => void;
    vi.mocked(f.transport.start).mockImplementationOnce((_offer, receive) => {
      event = receive;
      return new Promise(() => {});
    });
    const pending = f.broker.start('owner', f.request);
    const checked = expect(pending).rejects.toMatchObject({ code: 'VOICE_AUTHORITY_VIOLATION' });
    const snapshot = f.broker.heartbeat('owner', 'v1', {
      generation: 1,
      observation: { peerState: 'connected', muted: false, playback: 'playing' },
    });
    expect(snapshot.phase).toBe('starting');
    event({
      type: 'handoff',
      handoffId: 'premature',
      text: 'not authorized by browser observation',
    });
    expect(f.admit).not.toHaveBeenCalled();
    await checked;
    await f.broker.shutdown();
  });
  it('settles pending start on explicit stop even when injected start ignores cancellation', async () => {
    const f = fixture();
    vi.mocked(f.transport.start).mockImplementationOnce(() => new Promise(() => {}));
    const pending = f.broker.start('owner', f.request);
    const checked = expect(pending).rejects.toMatchObject({ code: 'VOICE_NEGOTIATION_EXPIRED' });
    await f.broker.stop('owner', 'v1', 1);
    await checked;
    expect(f.transport.stop).toHaveBeenCalledOnce();
    await f.broker.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds start timeout and cleanup failure without claiming a clean stop', async () => {
    const f = fixture();
    vi.mocked(f.transport.start).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(f.transport.stop).mockImplementationOnce(() => new Promise(() => {}));
    const pending = f.broker.start('owner', f.request);
    const checked = expect(pending).rejects.toMatchObject({ code: 'VOICE_NEGOTIATION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(24_000);
    await checked;
    expect(f.broker.get('owner', 'v1')).toMatchObject({
      phase: 'failed',
      failure: { code: 'VOICE_CLEANUP_FAILED' },
    });
    await f.broker.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('enforces hard duration, credential deadline, authority revocation and listener disposal', async () => {
    const f = fixture();
    const { voice } = await f.broker.start('owner', f.request, 2_000);
    const broken = vi.fn(() => {
      throw new Error('subscriber failed');
    });
    const good = vi.fn();
    f.broker.subscribe('owner', voice.id, broken);
    const unsubscribe = f.broker.subscribe('owner', voice.id, good);
    f.event({ type: 'transcript', itemId: 'a', role: 'user', text: 'hello', final: true });
    unsubscribe();
    f.event({ type: 'transcript', itemId: 'b', role: 'user', text: 'world', final: true });
    expect(broken).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.broker.get('owner', voice.id).failure?.code).toBe('VOICE_LEASE_EXPIRED');
    const next = await f.broker.start('owner', { ...f.request, requestId: 'r2' });
    f.revoke();
    await expect(
      f.broker.interrupt('owner', next.voice.id, next.voice.generation),
    ).rejects.toMatchObject({ code: 'VOICE_BINDING_CONFLICT' });
    await f.broker.sweep();
    expect(f.broker.get('owner', next.voice.id).failure?.code).toBe('VOICE_BINDING_CONFLICT');
    const other = fixture();
    const last = await other.broker.start('owner', other.request);
    vi.setSystemTime(last.voice.expiresAt);
    await other.broker.sweep();
    expect(other.broker.get('owner', last.voice.id).failure?.code).toBe('VOICE_DURATION_EXCEEDED');
    await f.broker.shutdown();
    await other.broker.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['accepted', 'unknown', 'failed'] as const)(
    'tracks result delivery %s without asserting playback',
    async (status) => {
      const f = fixture();
      if (status === 'unknown')
        vi.mocked(f.transport.deliver).mockRejectedValueOnce(new Error('private delivery error'));
      if (status === 'failed')
        f.admit.mockReturnValueOnce({
          runId: 'run-1',
          result: Promise.reject(new Error('private task failure')),
        });
      const { voice } = await f.broker.start('owner', f.request);
      f.event({ type: 'handoff', handoffId: 'h1', text: 'execute once' });
      await vi.advanceTimersByTimeAsync(0);
      const events = f.broker.events('owner', voice.id, 0);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'voice.result.delivery',
          payload: expect.objectContaining({ runId: 'run-1', status }),
        }),
      );
      expect(JSON.stringify(events)).not.toContain('private');
      expect(JSON.stringify(events)).not.toContain('playing');
      await f.broker.interrupt('owner', voice.id, voice.generation);
      expect(f.transport.interrupt).toHaveBeenCalledOnce();
      await f.broker.shutdown();
    },
  );
  it.each([
    'changed-handoff',
    'task-disabled',
    'large-transcript',
    'bad-handoff',
    'provider-error',
  ] as const)('fails closed on %s', async (fault) => {
    const f = fixture(fault === 'task-disabled' ? 'disabled' : 'daemon');
    const { voice } = await f.broker.start('owner', f.request);
    if (fault === 'changed-handoff') {
      f.event({ type: 'handoff', handoffId: 'h1', text: 'first' });
      f.event({ type: 'handoff', handoffId: 'h1', text: 'changed' });
    } else if (fault === 'large-transcript')
      f.event({
        type: 'transcript',
        itemId: 't',
        role: 'user',
        text: 'x'.repeat(voiceLimits.maxTranscriptBytes + 1),
        final: true,
      });
    else if (fault === 'provider-error')
      f.event({ type: 'error', error: new VoiceError('VOICE_ACCESS_DENIED', 403) });
    else f.event({ type: 'handoff', handoffId: fault === 'bad-handoff' ? '' : 'h1', text: 'task' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.broker.get('owner', voice.id).phase).toBe('failed');
    expect(f.transport.deliver).not.toHaveBeenCalled();
    await f.broker.shutdown();
  });
});
