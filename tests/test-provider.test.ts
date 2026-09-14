import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeterministicProvider } from '../src/providers/test.js';
import type { ProviderStreamEvent } from '../src/providers/types.js';

afterEach(() => vi.useRealTimers());

describe('deterministic browser fixtures', () => {
  it('produces a provisional tool turn followed by a complete long stream', async () => {
    vi.useFakeTimers();
    const provider = new DeterministicProvider();
    const request = {
      model: 'local-test',
      messages: [{ role: 'user' as const, content: 'browser long stream smoke' }],
    };
    const first: ProviderStreamEvent[] = [];
    for await (const event of provider.stream(request)) first.push(event);
    expect(first).toEqual(
      expect.arrayContaining([
        { type: 'delta', text: 'PROVISIONAL SHOULD DISAPPEAR' },
        expect.objectContaining({ type: 'tool_call', name: 'workspace.list' }),
      ]),
    );

    const second: ProviderStreamEvent[] = [];
    const completed = (async () => {
      for await (const event of provider.stream(request)) second.push(event);
    })();
    await vi.runAllTimersAsync();
    await completed;
    const streamed = second
      .filter(
        (event): event is Extract<ProviderStreamEvent, { type: 'delta' }> => event.type === 'delta',
      )
      .map((event) => event.text)
      .join('');
    expect(streamed).toContain('## Durable long response');
    expect(streamed).toContain('Evidence line 599');
    expect(streamed).toContain('FINAL_LONG_RESPONSE_SENTINEL');
    expect(streamed).not.toContain('PROVISIONAL SHOULD DISAPPEAR');
  });

  it('keeps the cancellation stream active until the caller aborts it', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const events: ProviderStreamEvent[] = [];
    let settled = false;
    const running = (async () => {
      for await (const event of new DeterministicProvider().stream({
        model: 'local-test',
        messages: [{ role: 'user', content: 'browser cancel smoke' }],
        signal: controller.signal,
      }))
        events.push(event);
    })().finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(settled).toBe(false);
    expect(events.some((event) => event.type === 'delta')).toBe(true);

    controller.abort();
    await vi.advanceTimersByTimeAsync(20);
    await running;
    expect(settled).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });
});
