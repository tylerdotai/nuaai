import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeterministicProvider } from '../src/providers/test.js';
import type { ProviderStreamEvent } from '../src/providers/types.js';

afterEach(() => vi.useRealTimers());

describe('deterministic browser fixtures', () => {
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
