import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolExecutionError } from './tool-errors.js';

const digest = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ) ?? 'null',
    )
    .digest('hex');

export class ToolProgressError extends ToolExecutionError {
  constructor(code: 'TOOL_NO_PROGRESS' | 'TOOL_UNCERTAIN_EFFECT', message: string) {
    super(
      message,
      code,
      'not_executed',
      code === 'TOOL_NO_PROGRESS' ? 'change_approach' : 'inspect_destination',
    );
    this.name = 'ToolProgressError';
  }
}

export class IdempotencyGuard {
  private observations: Array<{ key: string; outcome: string }> = [];
  private uncertain = new Set<string>();
  private uncertainExecution = false;
  private rejected = { key: '', count: 0 };
  private polls = new Map<string, number>();

  key(root: string, name: string, input: unknown): string {
    return digest({ root, name, input });
  }

  async before(
    key: string,
    name: string,
    sideEffects: string,
    executable: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (this.rejected.key === key && this.rejected.count >= 3)
      throw new ToolProgressError(
        'TOOL_NO_PROGRESS',
        'This invocation was not executed: the same request was rejected before execution three times. Inspect a different state signal or supply a valid request; do not assume a no-op or blindly retry.',
      );
    if (
      this.uncertain.has(key) ||
      (this.uncertainExecution && (executable || ['external', 'unknown'].includes(sideEffects)))
    )
      throw new ToolProgressError(
        'TOOL_UNCERTAIN_EFFECT',
        'This invocation was not executed: a prior effect may have occurred. Do not retry automatically or evade the guard with alternate arguments. Inspect the destination using an available read-only operation or ask the user to verify before a fresh authorized run.',
      );
    if (name === 'task.inspect') {
      const previous = this.polls.get(key);
      if (previous !== undefined)
        await delay(Math.max(0, 400 - (Date.now() - previous)), undefined, { signal });
      this.polls.set(key, Date.now());
      return;
    }
    if (sideEffects !== 'none') return;
    for (let width = 1; width <= 4; width += 1) {
      const recent = this.observations.slice(-width * 3);
      if (recent.length !== width * 3 || recent[0]?.key !== key) continue;
      const pattern = recent
        .slice(0, width)
        .map((entry) => `${entry.key}:${entry.outcome}`)
        .join('|');
      if (
        [1, 2].every(
          (repeat) =>
            recent
              .slice(repeat * width, (repeat + 1) * width)
              .map((entry) => `${entry.key}:${entry.outcome}`)
              .join('|') === pattern,
        )
      )
        throw new ToolProgressError(
          'TOOL_NO_PROGRESS',
          'This repeated read was not executed. The recent read-only cycle repeated three times with identical observed outcomes. This does not prove the current world is unchanged or that any action was a no-op. Inspect a different state signal or change the approach instead of repeating the same request.',
        );
    }
  }

  succeeded(key: string, name: string, sideEffects: string, result: unknown): void {
    this.rejected = { key: '', count: 0 };
    if (sideEffects !== 'none' || name === 'task.inspect') {
      this.observations = [];
      return;
    }
    this.observations.push({ key, outcome: digest(result) });
    this.observations = this.observations.slice(-12);
  }

  failed(key: string, sideEffects: string, error: unknown): void {
    if (error instanceof ToolExecutionError && error.executionState === 'not_executed') {
      this.rejected = { key, count: this.rejected.key === key ? this.rejected.count + 1 : 1 };
      return;
    }
    if (sideEffects !== 'none') this.uncertain.add(key);
    else {
      this.observations.push({
        key,
        outcome: digest({ failure: error instanceof Error ? error.message : String(error) }),
      });
      this.observations = this.observations.slice(-12);
    }
    if (error instanceof ToolExecutionError && error.executionState === 'uncertain')
      this.uncertainExecution = true;
  }
}
