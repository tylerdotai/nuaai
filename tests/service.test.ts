import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createUserServiceManager,
  renderUserServiceUnit,
  runUserServiceAction,
} from '../src/service.js';

describe('NUAAI user service', () => {
  it('renders a private restartable unit without enabling it implicitly', () => {
    const unit = renderUserServiceUnit({
      root: '/home/test/nuai project',
      nodePath: '/usr/bin/node',
      entryPath: '/opt/nuaai/scripts/nuaai-server.mjs',
      path: '/opt/codex/bin:/usr/bin:/bin',
    });

    expect(unit).toContain('Description=NUAAI local agent daemon');
    expect(unit).toContain('WorkingDirectory=/home/test/nuai\\x20project');
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/nuaai/scripts/nuaai-server.mjs"');
    expect(unit).toContain('Environment=PATH="/opt/codex/bin:/usr/bin:/bin"');
    expect(unit).toContain('Environment=TMPDIR="/home/test/nuai project/.nuaai/tmp"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('UMask=0077');
    expect(unit).toContain('PrivateTmp=false');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toContain('systemctl enable');
  });

  it('installs a private unit and reloads systemd without starting it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nuaai-service-'));
    const calls: string[][] = [];
    const manager = createUserServiceManager({
      homeDirectory: home,
      moduleDirectory: '/opt/nuaai/dist',
      nodePath: '/usr/bin/node',
      systemctl: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const root = join(home, 'nuai project');
    const path = await manager.install(root);

    expect(path).toBe(join(home, '.config/systemd/user/nuaai.service'));
    expect(await readFile(path, 'utf8')).toContain(
      'ExecStart="/usr/bin/node" "/opt/nuaai/scripts/nuaai-server.mjs"',
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, '.nuaai', 'tmp'))).mode & 0o777).toBe(0o700);
    expect(calls).toEqual([['--user', 'daemon-reload']]);
  });

  it('forwards explicit service actions and surfaces systemctl failures', async () => {
    const calls: string[][] = [];
    const manager = createUserServiceManager({
      homeDirectory: '/tmp/unused',
      moduleDirectory: '/opt/nuaai/dist',
      nodePath: '/usr/bin/node',
      systemctl: async (args) => {
        calls.push(args);
        return args.includes('restart')
          ? { exitCode: 1, stdout: '', stderr: 'restart failed' }
          : { exitCode: 0, stdout: 'inactive', stderr: '' };
      },
    });

    await expect(manager.run('status')).resolves.toMatchObject({ stdout: 'inactive' });
    await expect(manager.run('restart')).resolves.toMatchObject({ exitCode: 1 });
    expect(calls).toEqual([
      ['--user', 'status', '--no-pager', 'nuaai.service'],
      ['--user', 'restart', 'nuaai.service'],
    ]);
  });

  it('reports the real user-service status without changing service state', async () => {
    const result = await runUserServiceAction('status');

    expect(Number.isInteger(result.exitCode)).toBe(true);
    expect(`${result.stdout}\n${result.stderr}`).toContain('nuaai.service');
  });

  it('does not claim installation when daemon-reload fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nuaai-service-failed-'));
    const manager = createUserServiceManager({
      homeDirectory: home,
      moduleDirectory: '/opt/nuaai/dist',
      nodePath: '/usr/bin/node',
      systemctl: async () => ({ exitCode: 1, stdout: '', stderr: 'no user bus' }),
    });

    await expect(manager.install(join(home, 'nuai'))).rejects.toThrow('no user bus');
  });

  it('provides a fallback when systemctl returns no diagnostic text', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nuaai-service-empty-error-'));
    const manager = createUserServiceManager({
      homeDirectory: home,
      moduleDirectory: '/opt/nuaai/dist',
      nodePath: '/usr/bin/node',
      systemctl: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });

    await expect(manager.install(join(home, 'nuai'))).rejects.toThrow(
      'Failed to reload the user service manager',
    );
  });
});
