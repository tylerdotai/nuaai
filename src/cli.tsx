import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { render } from 'ink';
import { createElement } from 'react';

import { harnessConfig, loadRuntimeConfig } from './config/index.js';
import { startDaemon } from './daemon.js';
import { createBrowserPairingToken, ensureRuntimeIdentity } from './gateway/runtime.js';
import { runOnboarding } from './onboarding.js';
import { installUserService, runUserServiceAction } from './service.js';
import { Tui } from './ui/tui.js';
import { getVersion } from './version.js';
import { initWorkspace } from './workspace/fs.js';

async function daemonRequest(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetch(`${baseUrl}${path}`, init);
    if (!response.ok)
      throw new Error(`NUAAI daemon request failed at ${baseUrl}${path}: HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('NUAAI daemon request failed'))
      throw error;
    throw new Error(`NUAAI daemon is not reachable at ${baseUrl}. Start it with: nuaai daemon`);
  }
}

async function apiRequest<T>(baseUrl: string, token: string, path: string): Promise<T> {
  const response = await daemonRequest(baseUrl, path, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.json() as Promise<T>;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] === '--no-alt-screen' ? 'tui' : args[0];
  const commands = [
    'tui',
    'init',
    'daemon',
    'service',
    'onboard',
    'status',
    'doctor',
    'pair',
    'run',
    'identity',
    'version',
    '--version',
    '-v',
    'help',
    '--help',
    '-h',
  ];
  if (command && !commands.includes(command))
    throw new Error(`Unknown command: ${command}. Use nuaai --help.`);
  if (args.includes('--help') || args.includes('-h') || command === 'help') {
    process.stdout.write(
      'Usage: nuaai [command]\n\nCommands:\n  tui [--no-alt-screen]  Open terminal UI (default)\n  init                   Initialize runtime workspace\n  daemon                 Start daemon\n  onboard [--yes|--non-interactive] [--no-alt-screen]\n  service <install|start|stop|restart|status>\n  status | doctor        Inspect daemon\n  pair [base-url]        Create browser pairing URL\n  run <input>            Submit one run\n  identity [session-id] [--refresh]  Inspect/refresh frozen instruction sources\n  version                Print version\n\nOptions:\n  --help, -h             Show usage without contacting daemon\n  --version, -v          Print version\n  --no-alt-screen        Deliberate inline TUI mode\n',
    );
    return;
  }
  const tail = args[0] === '--no-alt-screen' ? args : args.slice(1);
  const allowed =
    command === 'onboard'
      ? ['--yes', '--non-interactive', '--no-alt-screen']
      : command === 'identity'
        ? ['--refresh']
        : command === 'tui'
          ? ['--no-alt-screen']
          : [];
  if (command !== 'run')
    for (const arg of tail) {
      if (arg.startsWith('-') && !allowed.includes(arg))
        throw new Error(`Unknown option: ${arg}. Use nuaai --help.`);
      if (
        command !== 'pair' &&
        command !== 'service' &&
        command !== 'identity' &&
        !arg.startsWith('-')
      )
        throw new Error(`Unknown argument: ${arg}. Use nuaai --help.`);
    }
  const root = resolve(process.env.NUAAI_ROOT?.trim() || homedir());
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }
  if (command === 'init') {
    const directory = await initWorkspace(root);
    process.stdout.write(`${harnessConfig.name} workspace: ${directory}\n`);
    return;
  }
  if (command === 'daemon') {
    await startDaemon(root);
    return;
  }
  if (command === 'service') {
    const action = args[1];
    if (action === 'install') {
      const path = await installUserService(root);
      process.stdout.write(`NUAAI user service installed: ${path}\n`);
      process.stdout.write('The service was not started or enabled.\n');
      return;
    }
    if (!action || !['start', 'stop', 'restart', 'status'].includes(action))
      throw new Error('Usage: nuaai service <install|start|stop|restart|status>');
    const result = await runUserServiceAction(action as 'start' | 'stop' | 'restart' | 'status');
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  if (command === 'onboard') {
    const onboarding = await runOnboarding(
      root,
      args.includes('--yes') || args.includes('--non-interactive'),
    );
    if (onboarding.launch === 'skip') return;
    const daemon = await startDaemon(root);
    const config = await loadRuntimeConfig(root);
    if (onboarding.launch === 'web') {
      process.stdout.write(
        `NUAAI web dashboard: http://${config.host}:${daemon.gateway.port}/#token=${encodeURIComponent(createBrowserPairingToken(root))}\n`,
      );
      return;
    }
    const identity = ensureRuntimeIdentity(root);
    try {
      await launchTui(
        createElement(Tui, {
          baseUrl: `http://${config.host}:${config.port}`,
          token: identity.token,
          root,
          workspaceRoot: process.cwd(),
        }),
        args.includes('--no-alt-screen'),
      );
    } finally {
      await daemon.stop();
    }
    return;
  }
  if (command === 'status' || command === 'doctor') {
    const config = await loadRuntimeConfig(root);
    const identity = ensureRuntimeIdentity(root);
    const result = await apiRequest<{ ok?: boolean; daemon?: boolean; providers?: unknown }>(
      `http://${config.host}:${config.port}`,
      identity.token,
      command === 'doctor' ? '/api/status' : '/health',
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'pair') {
    const config = await loadRuntimeConfig(root);
    const baseUrl = (args[1] ?? `http://${config.host}:${config.port}`).replace(/\/$/, '');
    process.stdout.write(
      `${baseUrl}/#token=${encodeURIComponent(createBrowserPairingToken(root))}\n`,
    );
    return;
  }
  if (command === 'identity') {
    const ids = tail.filter((value) => !value.startsWith('-'));
    if (ids.length > 1) throw new Error('Usage: nuaai identity [session-id] [--refresh]');
    const config = await loadRuntimeConfig(root);
    const credential = ensureRuntimeIdentity(root);
    const baseUrl = `http://${config.host}:${config.port}`;
    let id: string | undefined = ids[0];
    if (!id) {
      const result = await apiRequest<{ sessions: Array<{ id: string; sourceKey?: string }> }>(
        baseUrl,
        credential.token,
        '/api/sessions',
      );
      id = result.sessions.find(
        (session) => session.sourceKey === `cli:${resolve(process.cwd())}`,
      )?.id;
    }
    if (!id)
      throw new Error(
        'No CLI session exists for this workspace. Run a task first, or provide a session ID.',
      );
    const response = await daemonRequest(
      baseUrl,
      `/api/sessions/${encodeURIComponent(id)}/identity${args.includes('--refresh') ? '/refresh' : ''}`,
      {
        method: args.includes('--refresh') ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${credential.token}`,
          'content-type': 'application/json',
        },
        ...(args.includes('--refresh') ? { body: '{}' } : {}),
      },
    );
    process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
    return;
  }
  if (command === 'run') {
    const input = args.slice(1).join(' ').trim();
    if (!input) throw new Error('Usage: nuaai run <input>');
    const config = await loadRuntimeConfig(root);
    const identity = ensureRuntimeIdentity(root);
    const baseUrl = `http://${config.host}:${config.port}`;
    const sourceKey = `cli:${resolve(process.cwd())}`;
    const response = await daemonRequest(baseUrl, '/api/sessions/resolve', {
      method: 'POST',
      headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'CLI session', sourceKey, workspaceRoot: process.cwd() }),
    });
    const session = (await response.json()) as { thread: { id: string } };
    const runResponse = await daemonRequest(baseUrl, '/api/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: session.thread.id, input }),
    });
    process.stdout.write(`${JSON.stringify(await runResponse.json(), null, 2)}\n`);
    return;
  }
  const config = await loadRuntimeConfig(root);
  const identity = ensureRuntimeIdentity(root);
  await launchTui(
    createElement(Tui, {
      baseUrl: `http://${config.host}:${config.port}`,
      token: identity.token,
      root,
      workspaceRoot: process.cwd(),
    }),
    args.includes('--no-alt-screen'),
  );
}

async function launchTui(
  element: ReturnType<typeof createElement>,
  inline: boolean,
): Promise<void> {
  const app = render(element, { alternateScreen: !inline });
  const stop = () => app.unmount();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await app.waitUntilExit();
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    app.cleanup();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
