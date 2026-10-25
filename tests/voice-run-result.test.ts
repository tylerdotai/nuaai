import { describe, expect, it } from 'vitest';
import { voiceRunResult } from '../src/voice/run-result.js';

describe('authoritative voice run outcome', () => {
  it('preserves completed output exactly', async () => {
    expect(
      await voiceRunResult(
        Promise.resolve({ status: 'completed', output: 'Exact completed result.\n' }),
      ),
    ).toBe('Exact completed result.\n');
  });
  it.each([
    ['failed', 'The delegated task failed. No completed result is available.'],
    ['cancelled', 'The delegated task was cancelled. No completed result is available.'],
    ['running', 'The delegated task result could not be confirmed. Do not report it as completed.'],
    ['queued', 'The delegated task result could not be confirmed. Do not report it as completed.'],
    ['paused', 'The delegated task result could not be confirmed. Do not report it as completed.'],
    ['unknown', 'The delegated task result could not be confirmed. Do not report it as completed.'],
  ])('never reads %s output or claims no side effects', async (status, expected) => {
    const result = {
      status,
      get output(): string {
        throw new Error('synthetic-private-output');
      },
    };
    expect(await voiceRunResult(Promise.resolve(result))).toBe(expected);
  });
  it('rejected observation never forwards raw error or claims task failure/completion', async () => {
    const hostile = {
      get message() {
        throw new Error('synthetic-private-error');
      },
      toString() {
        throw new Error('synthetic-private-error');
      },
    };
    expect(await voiceRunResult(Promise.reject(hostile))).toBe(
      'The delegated task result could not be confirmed. Do not report it as completed.',
    );
  });
});
