import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

export interface UserServiceUnitOptions {
  root: string;
  nodePath: string;
  entryPath: string;
  path?: string;
}

export interface SystemctlResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface UserServiceManagerDependencies {
  homeDirectory: string;
  moduleDirectory: string;
  nodePath: string;
  path?: string;
  systemctl: (args: string[]) => Promise<SystemctlResult>;
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function systemdPath(value: string): string {
  return resolve(value).replace(
    /[^A-Za-z0-9_./-]/g,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

export function renderUserServiceUnit(options: UserServiceUnitOptions): string {
  const servicePath = options.path ?? `${dirname(options.nodePath)}:/usr/local/bin:/usr/bin:/bin`;
  const temporaryDirectory = resolve(options.root, '.nuaai', 'tmp');
  return `${[
    '[Unit]',
    'Description=NUAAI local agent daemon',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${systemdPath(options.root)}`,
    `ExecStart=${systemdQuote(options.nodePath)} ${systemdQuote(options.entryPath)}`,
    'Environment=NODE_ENV=production',
    `Environment=PATH=${systemdQuote(servicePath)}`,
    `Environment=TMPDIR=${systemdQuote(temporaryDirectory)}`,
    'Restart=on-failure',
    'RestartSec=3',
    'TimeoutStopSec=30',
    'UMask=0077',
    'PrivateTmp=false',
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n')}\n`;
}

async function systemctl(args: string[]): Promise<SystemctlResult> {
  const result = await execa('systemctl', args, { reject: false });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function createUserServiceManager(dependencies: UserServiceManagerDependencies) {
  return {
    async install(root: string): Promise<string> {
      const entryPath = resolve(dependencies.moduleDirectory, '../scripts/nuaai-server.mjs');
      const unitPath = resolve(dependencies.homeDirectory, '.config/systemd/user/nuaai.service');
      const temporaryDirectory = resolve(root, '.nuaai', 'tmp');
      await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      await chmod(temporaryDirectory, 0o700);
      await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
      await writeFile(
        unitPath,
        renderUserServiceUnit({
          root,
          nodePath: dependencies.nodePath,
          entryPath,
          path: dependencies.path,
        }),
        { encoding: 'utf8', mode: 0o600 },
      );
      await chmod(unitPath, 0o600);
      const result = await dependencies.systemctl(['--user', 'daemon-reload']);
      if (result.exitCode !== 0)
        throw new Error(result.stderr || 'Failed to reload the user service manager');
      return unitPath;
    },
    run(action: 'start' | 'stop' | 'restart' | 'status'): Promise<SystemctlResult> {
      const args =
        action === 'status'
          ? ['--user', 'status', '--no-pager', 'nuaai.service']
          : ['--user', action, 'nuaai.service'];
      return dependencies.systemctl(args);
    },
  };
}

function defaultManager() {
  return createUserServiceManager({
    homeDirectory: homedir(),
    moduleDirectory: dirname(fileURLToPath(import.meta.url)),
    nodePath: process.execPath,
    path: process.env.PATH,
    systemctl,
  });
}

export function installUserService(root: string): Promise<string> {
  return defaultManager().install(root);
}

export function runUserServiceAction(
  action: 'start' | 'stop' | 'restart' | 'status',
): Promise<SystemctlResult> {
  return defaultManager().run(action);
}
