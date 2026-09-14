export class SessionRunQueue {
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly writers = new Map<string, string>();
  private readonly waitingBySession = new Map<string, number>();
  private waiting = 0;

  enqueue<T>(sessionKey: string, runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(sessionKey) ?? Promise.resolve();
    this.waiting += 1;
    this.waitingBySession.set(sessionKey, (this.waitingBySession.get(sessionKey) ?? 0) + 1);
    const result = previous.then(async () => {
      this.waiting -= 1;
      const sessionWaiting = (this.waitingBySession.get(sessionKey) ?? 1) - 1;
      if (sessionWaiting > 0) this.waitingBySession.set(sessionKey, sessionWaiting);
      else this.waitingBySession.delete(sessionKey);
      this.writers.set(sessionKey, runId);
      try {
        return await task();
      } finally {
        if (this.writers.get(sessionKey) === runId) this.writers.delete(sessionKey);
      }
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(sessionKey, tail);
    void tail.then(() => {
      if (this.lanes.get(sessionKey) === tail) this.lanes.delete(sessionKey);
    });
    return result;
  }

  activeRun(sessionKey: string): string | undefined {
    return this.writers.get(sessionKey);
  }

  isWriter(sessionKey: string, runId: string): boolean {
    return this.writers.get(sessionKey) === runId;
  }

  queuedRuns(sessionKey?: string): number {
    if (!sessionKey) return this.waiting;
    return this.waitingBySession.get(sessionKey) ?? 0;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.lanes.values()]);
  }
}
