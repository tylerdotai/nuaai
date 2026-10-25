import type { RunRow } from '../memory/db.js';

const unconfirmed =
  'The delegated task result could not be confirmed. Do not report it as completed.';

/** A speakable outcome, not a task-status mutation or an assertion about side effects.
 * Failed/cancelled output and observation errors are never inspected or forwarded.
 * Delivery still passes through the broker's original correlation and authority fences.
 */
export async function voiceRunResult(
  result: Promise<Pick<RunRow, 'status' | 'output'>>,
): Promise<string> {
  try {
    const run = await result;
    switch (run.status) {
      case 'completed':
        return run.output;
      case 'failed':
        return 'The delegated task failed. No completed result is available.';
      case 'cancelled':
        return 'The delegated task was cancelled. No completed result is available.';
      default:
        return unconfirmed;
    }
  } catch {
    return unconfirmed;
  }
}
