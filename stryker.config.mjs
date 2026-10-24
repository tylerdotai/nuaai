/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  // Full critical-path mutation is a nightly/manual audit, not a PR gate.
  // Keep its complete scope here; bounded focused review checks may select
  // explicit modules/ranges with --mutate without claiming a full audit pass.
  mutate: [
    'src/gateway/**/*.ts',
    'src/security/**/*.ts',
    'src/core/approvals.ts',
    'src/core/events.ts',
    'src/memory/db.ts',
    'src/artifacts/registry.ts',
    'src/providers/**/*.ts',
    'src/integrations/**/*.ts',
    'src/tools/registry.ts',
    'src/skills/**/*.ts',
    'src/plugins/**/*.ts',
    'src/workspace/fs.ts',
  ],
  // Only the unit tier feeds mutation feedback. Integration and E2E suites
  // are too slow to be re-run for every mutant.
  vitest: {
    configFile: 'vitest.unit.config.ts',
  },
  // These are overall audit thresholds, not per-file enforcement.
  // A score below 60% fails the audit; 80% remains the high-score target.
  thresholds: {
    high: 80,
    low: 60,
    break: 60,
  },
  // Stryker's defaults produce a large number of mutants for trivial
  // expressions. Disable string-literal and unary-operator mutants which
  // are usually killed only by accident and don't reflect the quality of the
  // assertions.
  mutator: {
    excludedMutations: ['StringLiteral', 'UnaryOperator'],
  },
  // Keep reporters minimal in CI; the JSON reporter is consumed by the
  // stryker dashboard if it is wired up later.
  reporters: ['progress', 'clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  clearTextReporter: {
    fileName: 'reports/mutation/mutation.txt',
    reportType: 'text',
  },
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
};
