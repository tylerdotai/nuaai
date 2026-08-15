import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      all: true,
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
        'src/providers/codex.ts',
        'src/providers/ollama.ts',
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
