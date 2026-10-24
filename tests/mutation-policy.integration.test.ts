import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const root = new URL('../', import.meta.url);

it('keeps normal CI quality gates blocking without running the full mutation audit on pull requests', async () => {
  const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
  expect(workflow).toContain('pull_request:');
  expect(workflow).toContain('npm run check');
  expect(workflow).toContain('npm run test:integration');
  expect(workflow).toContain('npm run test:e2e');
  expect(workflow).toContain('npm run gate');
  expect(workflow).not.toContain('npm run test:mutate');
  expect(workflow).not.toMatch(/^ {2}mutation:/mu);
  expect(workflow).not.toContain('continue-on-error');
});

it('runs full mutation only as a scheduled or explicitly requested audit and preserves failures', async () => {
  const workflow = await readFile(new URL('.github/workflows/mutation.yml', root), 'utf8');
  expect(workflow).toMatch(/^ {2}schedule:/mu);
  expect(workflow).toMatch(/^ {2}workflow_dispatch:/mu);
  expect(workflow).not.toMatch(/^ {2}(?:pull_request|push):/mu);
  expect(workflow).toContain('timeout-minutes: 360');
  expect(workflow).toContain('npm run test:mutate -- --concurrency 2');
  expect(workflow).toContain('--mutate "$MUTATE_TARGETS"');
  expect(workflow).toContain('if: always()');
  expect(workflow).toContain('actions/upload-artifact@v4');
  expect(workflow).not.toContain('continue-on-error');
  expect(workflow).not.toContain('|| true');
  expect(workflow).not.toContain('--thresholds');
});

it('retains the actual full mutation scope, score floor and excluded operators', async () => {
  const configUrl = new URL('stryker.config.mjs', root).href;
  const { stdout } = await execute(process.execPath, [
    '--input-type=module',
    '-e',
    'const config = (await import(process.argv[1])).default; console.log(JSON.stringify(config));',
    configUrl,
  ]);
  const config = JSON.parse(stdout);
  expect(config.thresholds).toEqual({ high: 80, low: 60, break: 60 });
  expect(config.mutate).toEqual([
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
  ]);
  expect(config.mutator.excludedMutations).toEqual(['StringLiteral', 'UnaryOperator']);
  expect(config.vitest.configFile).toBe('vitest.unit.config.ts');
});
