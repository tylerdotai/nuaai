import { expect, it } from 'vitest';
import { hasRelevantVerificationEvidence } from '../src/core/capabilities.js';

it('distinguishes explicit tool invocation identifiers from file targets while requiring exact successful readback for every real target', () => {
  const input =
    'Use workspace.write to create approved-trial.txt with exactly LIVE_APPROVED followed by one newline. Then use workspace.read on approved-trial.txt to verify its bytes and reply LIVE_APPROVED.';
  const rows = [
    {
      name: 'workspace.write',
      arguments: { path: 'approved-trial.txt', content: 'LIVE_APPROVED\n' },
      result: { written: 'approved-trial.txt' },
    },
    {
      name: 'workspace.read',
      arguments: { path: 'approved-trial.txt' },
      result: 'LIVE_APPROVED\n',
    },
  ];
  expect(hasRelevantVerificationEvidence(input, 'external_side_effect', rows)).toBe(true);
  expect(hasRelevantVerificationEvidence(input, 'external_side_effect', rows.slice(0, 1))).toBe(
    false,
  );
  expect(
    hasRelevantVerificationEvidence(
      `${input} Also create other.txt.`,
      'external_side_effect',
      rows,
    ),
  ).toBe(false);
  expect(
    hasRelevantVerificationEvidence(input, 'external_side_effect', [
      rows[0],
      { ...rows[1], result: 'wrong bytes' },
    ]),
  ).toBe(false);
  expect(
    hasRelevantVerificationEvidence(
      'Create workspace.write as a file.',
      'external_side_effect',
      rows,
    ),
  ).toBe(false);
});
