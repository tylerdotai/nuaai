import { defineConfig } from 'vitest/config';

// Integration tier: real SQLite via temp dirs, real HTTP servers, real
// subprocesses. Run with `npm run test:integration`. The coverage gate
// here enforces the 80% per-file floor on critical-path files because
// those modules are exercised exclusively by integration tests.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.integration.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.d.ts',
        'src/cli.tsx',
        'src/onboarding.ts',
        'src/server.ts',
        'src/daemon.ts',
        'src/ui/**',
        'src/web/**',
        'src/memory/schema.ts',
        'src/providers/types.ts',
      ],
      thresholds: {
        perFile: true,
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
