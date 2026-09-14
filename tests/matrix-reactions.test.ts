import { describe, expect, it } from 'vitest';

import { MatrixReactionCoordinator } from '../src/integrations/matrix-reactions.js';

describe('Matrix reaction coordination', () => {
  it('sends the same status reaction only once', async () => {
    const sent: string[] = [];
    const coordinator = new MatrixReactionCoordinator(
      async (key) => {
        sent.push(key);
        return `event-${key}`;
      },
      async () => undefined,
    );

    await Promise.all([coordinator.set('working'), coordinator.set('working')]);
    await coordinator.set('working');

    expect(sent).toEqual(['working']);
  });

  it('rejects blank keys and retries the same status after a failed send', async () => {
    let attempts = 0;
    const coordinator = new MatrixReactionCoordinator(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary reaction failure');
        return 'event-working';
      },
      async () => undefined,
    );

    await expect(coordinator.set(' ')).rejects.toThrow('Matrix reaction key is required');
    await expect(coordinator.set('working')).rejects.toThrow('temporary reaction failure');
    await expect(coordinator.set('working')).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('serializes status changes and removes the previous reaction', async () => {
    const sent: string[] = [];
    const redacted: string[] = [];
    let release!: () => void;
    const firstSend = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new MatrixReactionCoordinator(
      async (key) => {
        sent.push(key);
        if (sent.length === 1) await firstSend;
        return `event-${key}`;
      },
      async (eventId) => {
        redacted.push(eventId);
      },
    );

    const working = coordinator.set('working');
    await Promise.resolve();
    const action = coordinator.set('action');
    const duplicate = coordinator.set('action');
    release();
    await Promise.all([working, action, duplicate]);

    expect(sent).toEqual(['working', 'action']);
    expect(redacted).toEqual(['event-working']);
  });
});
