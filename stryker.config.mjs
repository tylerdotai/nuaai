/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  runners: ['vitest'],
  testRunner: 'vitest',
  // Mutation testing the entire `src/` tree on every CI run would burn the
  // budget on presentation code and entry points. Limit mutation to the
  // critical paths documented in TESTING.md (security, providers, tool
  // registry, approvals, database, artifact storage, integrations). This
  // catches the meaningful behavioural bugs while keeping mutation runtime
  // under a few minutes on CI.
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
  // Report a per-file mutation score; fail the build if any critical file
  // drops below 60% killed. The mutation score is the percentage of mutants
  // killed by the test suite; higher means the suite catches injected bugs.
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
  reporters: ['progress', 'clear-text-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  clearTextReporter: {
    fileName: 'reports/mutation/mutation.txt',
    reportTypes: ['text', 'html'],
  },
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  reportFile: 'reports/mutation',
};
