export type MatrixReactionSender = (key: string) => Promise<string>;
export type MatrixReactionRedactor = (eventId: string) => Promise<void>;

export class MatrixReactionCoordinator {
  private desiredKey: string | undefined;
  private currentKey: string | undefined;
  private currentEventId: string | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly send: MatrixReactionSender,
    private readonly redact: MatrixReactionRedactor,
  ) {}

  set(key: string): Promise<void> {
    if (!key.trim()) return Promise.reject(new Error('Matrix reaction key is required'));
    if (this.currentKey === key && !this.running) return Promise.resolve();
    this.desiredKey = key;
    if (!this.running) {
      const run = this.flush();
      this.running = run;
      run.then(
        () => {
          if (this.running === run) this.running = undefined;
        },
        () => {
          if (this.running === run) this.running = undefined;
        },
      );
    }
    return this.running;
  }

  private async flush(): Promise<void> {
    while (this.desiredKey && this.currentKey !== this.desiredKey) {
      const key = this.desiredKey;
      const eventId = await this.send(key);
      const previous = this.currentEventId;
      this.currentKey = key;
      this.currentEventId = eventId;
      if (previous) await this.redact(previous);
    }
  }
}
