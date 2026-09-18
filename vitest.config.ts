import { defineConfig } from 'vitest/config';

// Combined tier (used by `npm test` and the release gate): runs every
// test, both unit and integration, with coverage. The per-file floor is
// 80% lines/functions/branches/statements on every in-scope file. The
// 80% number is achievable because the integration suite covers the
// files the unit suite cannot reach.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      // Presentation (src/ui, src/web), schema declarations, and process
      // entrypoints (src/cli.tsx, src/onboarding.ts, src/daemon.ts,
      // src/server.ts) are tested at the integration or E2E tier rather
      // than via coverage. Provider/types.ts is type-only.
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
