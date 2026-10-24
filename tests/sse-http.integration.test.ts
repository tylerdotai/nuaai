import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('streams an authenticated persisted event over the real HTTP bridge before the stream closes', async () => {
  const h = await identityHarness(undefined, (config) => {
    config.learning.mode = 'off';
  });
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error('SSE bridge did not flush headers/events')),
    2000,
  );
  try {
    const response = await fetch(`http://127.0.0.1:${h.daemon.gateway.port}/api/agent/stream`, {
      headers: { authorization: `Bearer ${h.daemon.token}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const session = h.daemon.runtime.createSession('SSE bridge', 'sse-bridge', undefined, {
      workspaceRoot: h.project,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE reader unavailable');
    let text = '';
    while (!text.includes('event: session.created\n')) {
      const frame = await reader.read();
      if (frame.done) throw new Error('SSE closed before delivering the event');
      text += new TextDecoder().decode(frame.value);
    }
    expect(text).toContain(session.session.id);
    const packets = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    expect(packets.some((packet) => packet.event.type === 'session.created')).toBe(true);
    for (const packet of packets) {
      expect(packet.id).toBeTypeOf('number');
      expect(packet.event.id).toBe(packet.id);
      expect(h.daemon.store.listEvents(packet.id - 1, 1)[0]?.eventId).toBe(packet.event.eventId);
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await h.close();
  }
}, 10_000);
