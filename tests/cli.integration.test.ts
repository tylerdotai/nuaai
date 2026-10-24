import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { workspaceDirectory } from '../src/config/index.js';
import { initWorkspace } from '../src/workspace/fs.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('CLI daemon diagnostics', () => {
  it('uses the home runtime from an unrelated directory without creating local state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nuaai-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'nuaai-caller-'));
    roots.push(home, cwd);
    await initWorkspace(home);
    const configPath = join(workspaceDirectory(home), 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.port = 59_998;
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const result = await execa(
      resolve('node_modules/.bin/tsx'),
      [resolve('src/cli.tsx'), 'doctor'],
      {
        cwd,
        env: { HOME: home, NUAAI_ROOT: '' },
        reject: false,
        timeout: 10_000,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('NUAAI daemon is not reachable at http://127.0.0.1:59998');
    await expect(readFile(join(cwd, '.nuaai/runtime.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('reports an actionable endpoint and start command when the daemon is stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-cli-'));
    roots.push(root);
    await initWorkspace(root);
    const configPath = join(workspaceDirectory(root), 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.port = 59_999;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    const result = await execa(
      resolve('node_modules/.bin/tsx'),
      [resolve('src/cli.tsx'), 'doctor'],
      { cwd: root, env: { NUAAI_ROOT: root }, reject: false, timeout: 10_000 },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('NUAAI daemon is not reachable at http://127.0.0.1:59999');
    expect(result.stderr).toContain('Start it with: nuaai daemon');
    expect(result.stderr).not.toContain('fetch failed');
  });

  it('prints an explicit fragment-based browser pairing URL without contacting the daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-cli-pair-'));
    roots.push(root);
    await initWorkspace(root);
    const result = await execa(
      resolve('node_modules/.bin/tsx'),
      [resolve('src/cli.tsx'), 'pair', 'https://agent.example/nuaai/'],
      { cwd: root, env: { NUAAI_ROOT: root }, reject: false, timeout: 10_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^https:\/\/agent\.example\/nuaai\/#token=[^\s]+$/);
    const pairingToken = new URL(result.stdout).hash.replace(/^#token=/, '');
    const [body] = decodeURIComponent(pairingToken).split('.');
    const payload = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')) as {
      purpose?: string;
      iat?: number;
      exp?: number;
    };
    expect(payload).toMatchObject({ purpose: 'browser-pairing' });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
    expect(result.stderr).toBe('');
  });
});
