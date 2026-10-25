import { describe, expect, it, vi } from 'vitest';
import type { VoiceProviderEvent } from '../src/voice/broker.js';
import { NativeVoiceTransport } from '../src/voice/native-transport.js';
import type { NativeVoiceWire } from '../src/voice/native-wire.js';

// Entirely in-memory: no host/provider construction, process, auth store or network.
function fixture(coalesced = false) {
  let receive: (frame: unknown) => void = () => {};
  const sent: Record<string, unknown>[] = [];
  const close = vi.fn(async () => {});
  const events: VoiceProviderEvent[] = [];
  const frame = (type: string, fields: Record<string, unknown> = {}) =>
    receive({ v: 1, type, ...fields });
  const wire: NativeVoiceWire = {
    subscribe: (listener) => {
      receive = listener;
      return () => {};
    },
    close,
    send: (command) => {
      sent.push(command);
      if (command.type === 'hello')
        frame('hello', {
          commandId: command.commandId,
          profile: 'subscription-webrtc-v3',
          interruption: 'unsupported',
        });
      if (command.type === 'start') {
        frame('answer', { commandId: command.commandId, sdp: 'synthetic-answer' });
        if (coalesced) {
          frame('control_ready', { commandId: command.commandId });
          frame('transcript', {
            itemId: 'user-0',
            role: 'user',
            text: 'speech, not a task',
            status: 'final',
          });
          frame('handoff', { handoffId: 'A', text: 'explicit task' });
        }
      }
    },
  };
  const transport = new NativeVoiceTransport(wire, 'subscription-webrtc-v3');
  const start = () =>
    transport.start('synthetic-offer', (event) => events.push(event), new AbortController().signal);
  const acknowledgeClose = () => {
    const command = sent.at(-1);
    expect(command?.type).toBe('close');
    frame('closed', { commandId: command?.commandId });
  };
  return { transport, start, frame, close, events, sent, acknowledgeClose };
}

describe('independent live profile lifecycle boundaries', () => {
  it('returns the answer while join is held, then reports a typed join failure once', async () => {
    const f = fixture();
    expect(await f.start()).toBe('synthetic-answer');
    expect(f.sent.map((command) => command.type)).toEqual(['hello', 'start']);
    expect(f.events).toEqual([]);
    f.transport.acceptAnswer();
    f.frame('error', { code: 'VOICE_ACCESS_DENIED' });
    f.frame('control_ready', { commandId: 2 });
    f.frame('handoff', { handoffId: 'late', text: 'must not run' });
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ type: 'error', error: { code: 'VOICE_ACCESS_DENIED' } });
    await f.transport.stop();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('fences coalesced answer/ready/transcript/handoff until host answer acceptance', async () => {
    const f = fixture(true);
    expect(await f.start()).toBe('synthetic-answer');
    expect(f.events).toEqual([]);
    f.transport.acceptAnswer();
    expect(f.events).toEqual([
      {
        type: 'transcript',
        itemId: 'user-0',
        role: 'user',
        text: 'speech, not a task',
        final: true,
      },
      { type: 'handoff', handoffId: 'A', text: 'explicit task' },
    ]);
    const stop = f.transport.stop();
    f.acknowledgeClose();
    await stop;
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('drains correlated canceled results and speech during stop without reviving either', async () => {
    const f = fixture(true);
    await f.start();
    f.transport.acceptAnswer();
    const delivery = f.transport
      .deliver('verified result', { handoffId: 'A', deliveryId: 'D' })
      .then(
        () => 'accepted',
        (error: { code: string }) => error.code,
      );
    const append = f.sent.at(-1);
    const count = f.events.length;
    const stop = f.transport.stop();
    f.frame('transcript', {
      itemId: 'assistant-0',
      role: 'assistant',
      text: 'late',
      status: 'final',
    });
    f.frame('delivery', {
      commandId: append?.commandId,
      handoffId: 'A',
      deliveryId: 'D',
      status: 'accepted',
    });
    f.acknowledgeClose();
    await stop;
    expect(await delivery).toBe('VOICE_DELIVERY_UNKNOWN');
    expect(f.events).toHaveLength(count);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('rejects a mismatched late delivery even during stop', async () => {
    const f = fixture(true);
    await f.start();
    f.transport.acceptAnswer();
    const delivery = f.transport
      .deliver('result', { handoffId: 'A', deliveryId: 'D' })
      .catch(() => {});
    const append = f.sent.at(-1);
    const stop = f.transport.stop();
    const rejected = expect(stop).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    f.frame('delivery', {
      commandId: append?.commandId,
      handoffId: 'A',
      deliveryId: 'different',
      status: 'accepted',
    });
    f.acknowledgeClose();
    await rejected;
    await delivery;
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('fails closed on an owner-drift error and ignores all subsequent provider speech/tasks', async () => {
    const f = fixture(true);
    await f.start();
    f.transport.acceptAnswer();
    f.frame('error', { code: 'VOICE_AUTHORITY_VIOLATION' });
    const count = f.events.length;
    f.frame('transcript', { itemId: 'user-1', role: 'user', text: 'late', status: 'final' });
    f.frame('handoff', { handoffId: 'B', text: 'late task' });
    expect(f.events).toHaveLength(count);
    expect(f.events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'VOICE_AUTHORITY_VIOLATION' },
    });
    await f.transport.stop();
    expect(f.close).toHaveBeenCalledOnce();
  });
});
