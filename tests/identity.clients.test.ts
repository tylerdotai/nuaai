import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { execa } from 'execa';
import { render } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { Tui } from '../src/ui/tui.js';
import { identityHarness } from './identity.harness.js';

it('carries the CLI launch project through the real daemon and offers private-content-free identity status and refresh', async () => {
  const h = await identityHarness();
  try {
    await writeFile(join(h.project, 'SOUL.md'), 'CLI_PROJECT_SOUL');
    await writeFile(join(h.project, 'AGENTS.md'), 'CLI_PROJECT_AGENTS');
    const cli = resolve('node_modules/.bin/tsx');
    const entry = resolve('src/cli.tsx');
    const result = await execa(cli, [entry, 'run', 'Fixture; do not use tools.'], {
      cwd: h.project,
      env: { NUAAI_ROOT: h.root },
    });
    const run = JSON.parse(result.stdout);
    expect((await h.daemon.runtime.waitForRun(run.id)).status).toBe('completed');
    expect(h.observed.at(-1)?.systemPrompt).toContain('CLI_PROJECT_SOUL');
    expect(h.observed.at(-1)?.systemPrompt).toContain('CLI_PROJECT_AGENTS');
    const session = h.daemon.runtime
      .listSessions()
      .find((value) => value.sourceKey === `cli:${h.project}`);
    if (!session) throw new Error('Missing CLI session');
    const status = await execa(cli, [entry, 'identity', session.id], {
      cwd: h.project,
      env: { NUAAI_ROOT: h.root },
    });
    expect(JSON.parse(status.stdout).workspaceRoot).toBe(h.project);
    expect(status.stdout).not.toContain('CLI_PROJECT_AGENTS');
    const refreshed = await execa(cli, [entry, 'identity', session.id, '--refresh'], {
      cwd: h.project,
      env: { NUAAI_ROOT: h.root },
    });
    expect(JSON.parse(refreshed.stdout).revision).toBe(2);
  } finally {
    await h.close();
  }
}, 15000);

it('loads project identity through actual TUI keys and exposes only source metadata with an explicit refresh confirmation', async () => {
  const h = await identityHarness();
  await writeFile(join(h.project, 'SOUL.md'), 'TUI_PRIVATE_SOUL_1');
  await writeFile(join(h.project, 'AGENTS.md'), 'TUI_PRIVATE_AGENTS_1');
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40 });
  let output = '';
  stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  const frame = () => {
    const starts = [
      ...output.matchAll(/\n NUAAI\n (?:Connected|Connecting|Loading|Disconnected)/gu),
    ];
    return output.slice(starts.at(-1)?.index ?? 0);
  };
  const app = render(
    createElement(Tui, {
      root: h.root,
      workspaceRoot: h.project,
      baseUrl: `http://127.0.0.1:${h.daemon.gateway.port}`,
      token: h.daemon.token,
    }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  const send = async (bytes: string, expected: string) => {
    await expect.poll(() => !frame().includes('Applying…')).toBe(true);
    await new Promise<void>((done) => setImmediate(done));
    const before = output.length;
    stdin.write(bytes);
    await expect
      .poll(() => (output.length > before ? frame() : ''), { timeout: 5000 })
      .toContain(expected);
  };
  try {
    await expect.poll(frame).toContain('identity r1');
    await send('Fixture; do not use tools.', 'Fixture; do not use tools.');
    await send('\r', 'Run accepted');
    await expect.poll(() => h.observed.length).toBe(1);
    expect(h.observed[0].systemPrompt).toContain('TUI_PRIVATE_SOUL_1');
    expect(h.observed[0].systemPrompt).toContain('TUI_PRIVATE_AGENTS_1');
    await send('keep my draft', 'keep my draft');
    await send('\u001by', 'Session identity');
    expect(frame()).toContain('project/AGENTS.md');
    expect(output).not.toContain('TUI_PRIVATE_AGENTS_1');
    await writeFile(join(h.project, 'AGENTS.md'), 'TUI_PRIVATE_AGENTS_2');
    await send('Refresh', 'Search: Refresh');
    await send('\r', 'Refresh session identity?');
    await send('\u001b[B', 'Reload instruction files');
    await send('\r', 'Identity refreshed');
    expect(frame()).toContain('Session identity');
    await send('\u001b', 'keep my draft');
    expect(frame()).toContain('keep my draft');
    expect(frame()).toContain('identity r2');
    expect(output).not.toContain('TUI_PRIVATE_AGENTS_2');
  } finally {
    app.unmount();
    app.cleanup();
    await h.close();
  }
}, 15000);
