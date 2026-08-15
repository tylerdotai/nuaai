import { defineConfig, devices } from '@playwright/test';

const e2ePort = Number(process.env.NUAAI_E2E_PORT ?? 49_187);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `NUAAI_TEST_MODE=1 NUAAI_PORT=${e2ePort} node dist/cli.js daemon`,
    url: `http://127.0.0.1:${e2ePort}/health`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
