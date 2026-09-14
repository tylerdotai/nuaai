import { defineConfig, devices } from '@playwright/test';

const e2ePort = Number(process.env.NUAAI_E2E_PORT ?? 49_187);
const projectRoot = process.cwd();
const daemonEntry = JSON.stringify(`${projectRoot}/dist/cli.js`);
const browserExecutable = process.env.NUAAI_PLAYWRIGHT_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    ...(browserExecutable ? { launchOptions: { executablePath: browserExecutable } } : {}),
  },
  webServer: {
    command: `NUAAI_TEST_MODE=1 NUAAI_PORT=${e2ePort} node ${daemonEntry} daemon`,
    url: `http://127.0.0.1:${e2ePort}/health`,
    reuseExistingServer: true,
    cwd: process.env.NUAAI_E2E_ROOT ?? process.cwd(),
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
