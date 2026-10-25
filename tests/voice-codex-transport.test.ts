import { describe, expect, it, vi } from 'vitest';
import type { VoiceProviderEvent } from '../src/voice/broker.js';
import {
  CodexVoiceTransport,
  type VoiceRpcWire,
  unsupportedCodexVoiceProvider,
} from '../src/voice/codex-transport.js';

function fixture(account = 'chatgpt') {
  let receive: (message: unknown) => void = () => {};
  const sent: Record<string, unknown>[] = [];
  const close = vi.fn(async () => {});
  const wire: VoiceRpcWire = {
    subscribe: (listener) => {
      receive = listener;
      return () => {
        receive = () => {};
      };
    },
    close,
    send: (raw) => {
      const message = raw as Record<string, unknown>;
      sent.push(message);
      if (!('id' in message) || !message.method) return;
      let result: unknown = {};
      if (message.method === 'account/read') result = { account: { type: account } };
      if (message.method === 'thread/start') result = { thread: { id: 'backing-1' } };
      if (message.method === 'thread/realtime/start') {
        receive({
          method: 'thread/realtime/sdp',
          params: { threadId: 'backing-1', sdp: 'answer-private' },
        });
        receive({
          method: 'thread/realtime/started',
          params: { threadId: 'backing-1', version: 'v3' },
        });
      }
      receive({ id: message.id, result });
    },
  };
  return {
    transport: new CodexVoiceTransport(wire),
    sent,
    close,
    receive: (message: unknown) => receive(message),
  };
}

describe('version-pinned Codex voice protocol adapter', () => {
  it('does not create a wire or perform account RPC for unavailable installed policy', () => {
    expect(unsupportedCodexVoiceProvider.availability()).toMatchObject({
      available: false,
      blocker: 'VOICE_EXECUTION_ISOLATION_UNVERIFIED',
      interruption: 'unsupported',
    });
    expect(() => unsupportedCodexVoiceProvider.create()).toThrow(
      /VOICE_EXECUTION_ISOLATION_UNVERIFIED/,
    );
  });
  it.each(['apiKey', 'amazonBedrock', 'unknown'])(
    'rejects %s auth without creating a backing thread or fallback',
    async (account) => {
      const f = fixture(account);
      await expect(
        f.transport.start('private-offer', () => {}, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'VOICE_SUBSCRIPTION_REQUIRED' });
      expect(f.sent.map((item) => item.method)).not.toContain('thread/start');
      expect(f.close).toHaveBeenCalledOnce();
    },
  );
  it('handles answer/started before response, sends fixed WebRTC/v3 and normalizes handoff IDs', async () => {
    const f = fixture();
    const events: VoiceProviderEvent[] = [];
    expect(
      await f.transport.start(
        'private-offer',
        (event) => events.push(event),
        new AbortController().signal,
      ),
    ).toBe('answer-private');
    expect(f.sent.find((item) => item.method === 'thread/realtime/start')?.params).toMatchObject({
      transport: { type: 'webrtc', sdp: 'private-offer' },
      version: 'v3',
      outputModality: 'audio',
      clientManagedHandoffs: true,
      flushTranscriptTailOnSessionEnd: false,
    });
    f.receive({
      method: 'thread/realtime/itemAdded',
      params: {
        threadId: 'backing-1',
        item: {
          type: 'handoff_request',
          handoff_id: 'handoff-1',
          item_id: 'item-1',
          input_transcript: 'request work',
        },
      },
    });
    expect(events).toEqual([{ type: 'handoff', handoffId: 'handoff-1', text: 'request work' }]);
    await expect(f.transport.interrupt()).rejects.toMatchObject({
      code: 'VOICE_INTERRUPTION_UNSUPPORTED',
    });
    await f.transport.stop();
    expect(f.sent.at(-1)?.method).toBe('thread/realtime/stop');
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('validates delivery IDs but labels legacy append as session-scoped, not delegation resolution', async () => {
    const f = fixture();
    await f.transport.start('offer', () => {}, new AbortController().signal);
    const context = { handoffId: 'handoff-1', deliveryId: 'delivery-1' };
    await f.transport.deliver('verified result', context);
    expect(f.sent.find((message) => message.method === 'thread/realtime/appendSpeech')).toEqual({
      id: expect.any(Number),
      method: 'thread/realtime/appendSpeech',
      params: { threadId: 'backing-1', text: 'verified result' },
    });
    await expect(
      f.transport.deliver('result', { ...context, handoffId: '' }),
    ).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    await expect(
      f.transport.deliver('result', { ...context, deliveryId: '' }),
    ).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
    await f.transport.stop();
  });
  it('rejects unsolicited execution and foreign notifications instead of forwarding authority', async () => {
    const f = fixture();
    const events: VoiceProviderEvent[] = [];
    await f.transport.start(
      'private-offer',
      (event) => events.push(event),
      new AbortController().signal,
    );
    f.receive({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'backing-1' },
    });
    expect(events).toContainEqual({ type: 'execution' });
    expect(f.sent.at(-1)).toMatchObject({ id: 'approval-1', error: { code: -32601 } });
    f.receive({
      method: 'thread/realtime/sdp',
      params: { threadId: 'foreign', sdp: 'do not expose' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'VOICE_PROTOCOL_ERROR' } });
    await f.transport.stop();
  });
});
