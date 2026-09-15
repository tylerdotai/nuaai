import { describe, expect, it } from 'vitest';

import {
  type DogfoodCase,
  type DogfoodEvidence,
  evaluateDogfoodCase,
  scoreDogfoodCampaign,
} from '../scripts/dogfood-campaign.js';

const specification: DogfoodCase = {
  id: 'case-01',
  category: 'workspace',
  title: 'Read the package version',
  prompt: 'Use workspace.read to read package.json and report the package version.',
  expectedTools: ['workspace.read'],
  requiredOutputTerms: ['1.0.1'],
  minOutputChars: 20,
};

function evidence(overrides: Partial<DogfoodEvidence> = {}): DogfoodEvidence {
  return {
    runId: 'run-1',
    status: 'completed',
    output: 'The package version is 1.0.1 and the evidence came from package.json.',
    startedAt: 100,
    completedAt: 250,
    terminalEvents: ['run.completed'],
    actions: [{ name: 'workspace.read', status: 'completed' }],
    modelAttempts: 2,
    deltaEvents: 3,
    ...overrides,
  };
}

describe('dogfood campaign scoring', () => {
  it('passes a completed run only when durable output and canonical action evidence agree', () => {
    const result = evaluateDogfoodCase(specification, evidence());

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.durationMs).toBe(150);
  });

  it('fails missing tools, unfinished actions, duplicate terminal events, and false limit errors', () => {
    const result = evaluateDogfoodCase(
      specification,
      evidence({
        output: 'NUAAI could not verify completion: the tool-turn limit was reached.',
        terminalEvents: ['run.completed', 'run.completed'],
        actions: [{ name: 'workspace.search', status: 'running' }],
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'expected tool not completed: workspace.read',
        'unfinished action: workspace.search',
        'expected exactly one terminal event, received 2',
        'durable output contains a false tool-turn-limit failure',
        'required output term missing: 1.0.1',
      ]),
    );
  });

  it('requires exactly twenty cases and blocks on any global safety violation', () => {
    const cases = Array.from({ length: 20 }, (_, index) => ({
      ...specification,
      id: `case-${String(index + 1).padStart(2, '0')}`,
    }));
    const results = cases.map((item) => evaluateDogfoodCase(item, evidence({ runId: item.id })));
    results[0] = {
      ...results[0],
      passed: false,
      failures: ['tool failed: workspace.read'],
      safetyViolation: true,
    };

    const score = scoreDogfoodCampaign(results);

    expect(score.total).toBe(20);
    expect(score.passed).toBe(19);
    expect(score.passRate).toBe(0.95);
    expect(score.reliabilityGatePassed).toBe(false);
    expect(score.globalSafetyViolations).toEqual(['case-01: tool failed: workspace.read']);
  });
});
