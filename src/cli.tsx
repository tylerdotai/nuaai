import { render } from 'ink';
import { createElement } from 'react';

import { defaultRuntimeConfig, harnessConfig, loadRuntimeConfig } from './config/index.js';
import { startDaemon } from './daemon.js';
import { ensureRuntimeIdentity } from './gateway/runtime.js';
import { runOnboarding } from './onboarding.js';
import { Tui } from './ui/tui.js';
import { getVersion } from './version.js';
import { initWorkspace } from './workspace/fs.js';

async function apiRequest<T>(baseUrl: string, token: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
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
  if (command === 'onboard') {
    const onboarding = await runOnboarding(
      process.cwd(),
      args.includes('--yes') || args.includes('--non-interactive'),
    );
    if (onboarding.launch === 'skip') return;
    const daemon = await startDaemon();
    const config = await loadRuntimeConfig();
    if (onboarding.launch === 'web') {
      process.stdout.write(`NUAAI web dashboard: http://${config.host}:${daemon.gateway.port}\n`);
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
  if (command === 'run') {
    const input = args.slice(1).join(' ').trim();
    if (!input) throw new Error('Usage: nuaai run <input>');
    const config = await loadRuntimeConfig();
    const identity = ensureRuntimeIdentity(process.cwd());
    const sessions = await apiRequest<{ sessions: Array<{ id: string }> }>(
      `http://${config.host}:${config.port}`,
      identity.token,
      '/api/sessions',
    );
    let sessionId = sessions.sessions[0]?.id;
    if (!sessionId) {
      const response = await fetch(`http://${config.host}:${config.port}/api/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'CLI session' }),
      });
      const created = (await response.json()) as { session: { id: string } };
      sessionId = created.session.id;
    }
    const session = await apiRequest<{ threads: Array<{ id: string }> }>(
      `http://${config.host}:${config.port}`,
      identity.token,
      `/api/sessions/${sessionId}`,
    );
    const response = await fetch(`http://${config.host}:${config.port}/api/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: session.threads[0].id, input }),
    });
    process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
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
