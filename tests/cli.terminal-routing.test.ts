import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { expect, it } from 'vitest';

it('routes help and invalid commands before config, identity, daemon or Ink initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-terminal-cli-'));
  try {
    await mkdir(join(root, '.nuaai'));
    await writeFile(join(root, '.nuaai/config.json'), 'not valid configuration');
    for (const args of [
      ['--help'],
      ['help'],
      ['tui', '--help'],
      ['not-a-command'],
      ['--unknown'],
      ['tui', '--unknown'],
    ]) {
      const help = args.includes('--help') || args[0] === 'help';
      const result = await execa(
        process.execPath,
        ['--import', 'tsx', resolve('src/cli.tsx'), ...args],
        { env: { NUAAI_ROOT: root }, reject: false, timeout: 10000 },
      );
      expect(result.exitCode).toBe(help ? 0 : 1);
      expect(help ? result.stdout : result.stderr).toContain(help ? 'Usage:' : 'Unknown');
      expect(result.all ?? `${result.stdout}${result.stderr}`).not.toContain('\u001b[');
    }
    expect(await readdir(join(root, '.nuaai'))).toEqual(['config.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
