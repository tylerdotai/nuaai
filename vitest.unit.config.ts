import { defineConfig } from 'vitest/config';

// Unit tier: pure logic, edge cases, reducers, contracts. Excludes
// integration files which need real SQLite, real HTTP servers, or
// subprocesses. Run with `npm run test:unit`.
//
// Coverage floor is a single 60% global number — the unit tier cannot
// reach every critical-path file because some of them (database, HTTP
// entrypoint, provider adapters, integration shims) need real boundaries
// that only the integration tier exercises. The integration tier carries
// the 80% per-file floor on those modules.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**', '**/*.integration.test.ts'],
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
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
});
