import { Text, render } from 'ink';
import { createElement } from 'react';

import { harnessConfig } from './config/index.js';
import { getVersion } from './version.js';
import { initWorkspace } from './workspace/fs.js';

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }

  if (command === 'init') {
    const directory = await initWorkspace();
    process.stdout.write(`${harnessConfig.name} workspace: ${directory}\n`);
    return;
  }

  render(
    createElement(
      Text,
      { color: 'cyan' },
      `${harnessConfig.name} — ${harnessConfig.tagline} v${getVersion()}`,
    ),
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
