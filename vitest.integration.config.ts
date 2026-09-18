import { defineConfig } from 'vitest/config';

// Integration tier: real SQLite via temp dirs, real HTTP servers, real
// subprocesses. Run with `npm run test:integration`. Coverage is not
// measured here — the unit tier carries the coverage floor.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.integration.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
  },
});
