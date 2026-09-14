import { resolve } from 'node:path';

import { render } from 'ink';
import { createElement } from 'react';

import { defaultRuntimeConfig, harnessConfig, loadRuntimeConfig } from './config/index.js';
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
  const command = args[0];
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }
  if (command === 'init') {
    const directory = await initWorkspace();
    process.stdout.write(`${harnessConfig.name} workspace: ${directory}\n`);
    return;
  }
  if (command === 'daemon') {
    await startDaemon();
    return;
  }
  if (command === 'service') {
    const action = args[1];
    if (action === 'install') {
      const path = await installUserService(process.cwd());
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
      process.cwd(),
      args.includes('--yes') || args.includes('--non-interactive'),
    );
    if (onboarding.launch === 'skip') return;
    const daemon = await startDaemon();
    const config = await loadRuntimeConfig();
    if (onboarding.launch === 'web') {
      process.stdout.write(
        `NUAAI web dashboard: http://${config.host}:${daemon.gateway.port}/#token=${encodeURIComponent(createBrowserPairingToken(process.cwd()))}\n`,
      );
      return;
    }
    const identity = ensureRuntimeIdentity(process.cwd());
    render(
      createElement(Tui, {
        baseUrl: `http://${config.host}:${config.port}`,
        token: identity.token,
      }),
    );
    return;
  }
  if (command === 'status' || command === 'doctor') {
    const config = await loadRuntimeConfig().catch(() => defaultRuntimeConfig());
    const identity = ensureRuntimeIdentity(process.cwd());
    const result = await apiRequest<{ ok?: boolean; daemon?: boolean; providers?: unknown }>(
      `http://${config.host}:${config.port}`,
      identity.token,
      command === 'doctor' ? '/api/status' : '/health',
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'pair') {
    const config = await loadRuntimeConfig().catch(() => defaultRuntimeConfig());
    const baseUrl = (args[1] ?? `http://${config.host}:${config.port}`).replace(/\/$/, '');
    process.stdout.write(
      `${baseUrl}/#token=${encodeURIComponent(createBrowserPairingToken(process.cwd()))}\n`,
    );
    return;
  }
  if (command === 'run') {
    const input = args.slice(1).join(' ').trim();
    if (!input) throw new Error('Usage: nuaai run <input>');
    const config = await loadRuntimeConfig();
    const identity = ensureRuntimeIdentity(process.cwd());
    const baseUrl = `http://${config.host}:${config.port}`;
    const sourceKey = `cli:${resolve(process.cwd())}`;
    const response = await daemonRequest(baseUrl, '/api/sessions/resolve', {
      method: 'POST',
      headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'CLI session', sourceKey }),
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
  const config = await loadRuntimeConfig().catch(() => defaultRuntimeConfig());
  const identity = ensureRuntimeIdentity(process.cwd());
  render(
    createElement(Tui, { baseUrl: `http://${config.host}:${config.port}`, token: identity.token }),
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
