import { spawn } from 'node:child_process';
import { access, chmod, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { type RuntimeConfig, defaultRuntimeConfig, loadRuntimeConfig } from './config/index.js';
import { initWorkspace } from './workspace/fs.js';

export type LaunchChoice = 'tui' | 'web' | 'skip';

export interface OnboardingAnswers {
  ollama: boolean;
  codex: boolean;
  matrix: boolean;
  search: boolean;
  browser: boolean;
  tailscale: boolean;
  provider: 'ollama' | 'codex';
  launch: LaunchChoice;
}

export interface OnboardingResult {
  config: RuntimeConfig;
  launch: LaunchChoice;
}

export function applyOnboardingAnswers(
  config: RuntimeConfig,
  answers: OnboardingAnswers,
): RuntimeConfig {
  const provider = answers.provider === 'codex' && answers.codex ? 'codex' : 'ollama';
  return {
    ...config,
    provider: { ...config.provider, name: provider },
    features: {
      ...config.features,
      ollama: answers.ollama,
      codex: answers.codex,
      matrix: answers.matrix,
      search: answers.search,
      browser: answers.browser,
      telemetry: false,
    },
    matrix: { ...config.matrix, enabled: answers.matrix },
  };
}

async function askYesNo(rl: ReturnType<typeof createInterface>, label: string, fallback: boolean) {
  const suffix = fallback ? 'Y/n' : 'y/N';
  const value = (await rl.question(`${label} [${suffix}] `)).trim().toLowerCase();
  if (!value) return fallback;
  return value === 'y' || value === 'yes';
}

async function askProvider(
  rl: ReturnType<typeof createInterface>,
  ollama: boolean,
  codex: boolean,
): Promise<'ollama' | 'codex'> {
  if (ollama && !codex) return 'ollama';
  if (codex && !ollama) return 'codex';
  const value = (await rl.question('Primary provider [ollama/codex, default ollama] '))
    .trim()
    .toLowerCase();
  return value === 'codex' ? 'codex' : 'ollama';
}

function runCommand(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveCode(code ?? (signal ? 1 : 0)));
  });
}

async function runLocalBootstrap(root: string): Promise<void> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const candidates = [
    resolve(root, 'scripts/setup-local-integrations.mjs'),
    resolve(packageRoot, 'scripts/setup-local-integrations.mjs'),
  ];
  for (const script of candidates) {
    try {
      await access(script);
      const code = await runCommand(process.execPath, [script], root);
      if (code !== 0) throw new Error(`Local integration bootstrap exited with code ${code}`);
      return;
    } catch (error) {
      if (error instanceof Error && !error.message.includes('ENOENT')) throw error;
    }
  }
  throw new Error('Local integration bootstrap script is not included in this installation');
}

async function enableTailscaleServe(synapseUrl: string): Promise<void> {
  const port = new URL(synapseUrl).port;
  const code = await runCommand('tailscale', ['serve', '--bg', port], process.cwd());
  if (code !== 0) throw new Error('Tailscale Serve could not expose the local Matrix homeserver');
}

export async function runOnboarding(
  root = process.cwd(),
  nonInteractive = false,
): Promise<OnboardingResult> {
  await initWorkspace(root);
  const current = await loadRuntimeConfig(root).catch(() => defaultRuntimeConfig(root));
  const defaults: OnboardingAnswers = {
    ollama: current.features.ollama,
    codex: current.features.codex,
    matrix: current.features.matrix || current.matrix.enabled,
    search: current.features.search,
    browser: current.features.browser,
    tailscale: false,
    provider: current.provider.name === 'codex' ? 'codex' : 'ollama',
    launch: 'skip',
  };
  let answers = defaults;
  if (!nonInteractive) {
    const rl = createInterface({ input, output });
    try {
      output.write(
        '\nNUAAI onboarding\n==============\nLocal-first defaults are enabled. Telemetry is permanently disabled.\n\n',
      );
      answers = {
        ...defaults,
        ollama: await askYesNo(rl, 'Enable Ollama local provider?', defaults.ollama),
        codex: await askYesNo(rl, 'Enable Codex CLI provider?', defaults.codex),
        matrix: await askYesNo(rl, 'Enable Matrix phone integration?', defaults.matrix),
        search: await askYesNo(
          rl,
          'Enable local SearXNG search with DuckDuckGo fallback?',
          defaults.search,
        ),
        browser: await askYesNo(
          rl,
          'Enable Playwright and FlareSolverr browser tools?',
          defaults.browser,
        ),
        provider: defaults.provider,
        tailscale: false,
        launch: 'skip',
      };
      answers.provider = await askProvider(rl, answers.ollama, answers.codex);
      answers.tailscale = answers.matrix
        ? await askYesNo(rl, 'Expose Matrix through authenticated Tailscale Serve?', false)
        : false;
      const launch = (await rl.question('After setup: launch [tui/web/skip, default skip] '))
        .trim()
        .toLowerCase();
      answers.launch = launch === 'tui' || launch === 'web' ? launch : 'skip';
    } finally {
      rl.close();
    }
  }

  const next = applyOnboardingAnswers(current, answers);
  const configPath = resolve(root, '.nuaai/config.json');
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(configPath, 0o600);

  let effective = next;
  if (answers.matrix || answers.search || answers.browser) {
    await runLocalBootstrap(root);
    effective = await loadRuntimeConfig(root);
  }
  if (answers.tailscale) await enableTailscaleServe(effective.matrix.homeserverUrl);

  output.write(`\nConfiguration saved to ${configPath}\n`);
  output.write('Telemetry: disabled\n');
  output.write(`Matrix: ${answers.matrix ? 'enabled' : 'disabled'}\n`);
  output.write(`Search: ${answers.search ? 'enabled' : 'disabled'}\n`);
  output.write(`Browser automation: ${answers.browser ? 'enabled' : 'disabled'}\n`);
  output.write(`Provider: ${effective.provider.name}\n`);
  return { config: effective, launch: answers.launch };
}
