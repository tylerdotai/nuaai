import { z } from 'zod';
import type { RuntimeConfig } from '../config/index.js';

export const MAX_GOAL_DURATION_MS = 604_800_000;
export const MAX_GOAL_RUNS = 100_000;

// A continuous objective is explicit and finite; it is never inferred from quoted text.
export const executionRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('standard') }).strict(),
  z
    .object({
      mode: z.literal('continuous'),
      durationMs: z.number().int().min(1_000).max(MAX_GOAL_DURATION_MS),
      maxRuns: z.number().int().positive().max(MAX_GOAL_RUNS),
    })
    .strict(),
]);
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export interface ExecutionPolicy {
  mode: 'standard' | 'continuous';
  durationMs: number;
  maxRuns: number;
  maxSlices: number;
}

export function executionPolicy(
  request: ExecutionRequest | undefined,
  limits: RuntimeConfig['limits'],
): ExecutionPolicy {
  const value = executionRequestSchema.parse(request ?? { mode: 'standard' });
  return value.mode === 'continuous'
    ? { ...value, maxSlices: value.maxRuns }
    : {
        mode: 'standard',
        durationMs: limits.goalTimeoutMs,
        maxRuns: limits.maxGoalFamilyRuns,
        maxSlices: limits.maxGoalSlices,
      };
}
