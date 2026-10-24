import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { createElement } from 'react';
import { expect } from 'vitest';
import { Tui } from '../src/ui/tui.js';
import { identityHarness } from './identity.harness.js';

export async function realTuiHarness() {
  const h = await identityHarness();
  const created = h.daemon.runtime.createSession(
    'Command acceptance',
    'tui:acceptance',
    undefined,
    { workspaceRoot: h.project },
  );
  const makeInput = () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => stdin,
      ref: () => stdin,
      unref: () => stdin,
    });
    return stdin;
  };
  let stdin = makeInput();
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 46 });
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
  const launch = () =>
    render(
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
  let app = launch();
  const send = async (bytes: string, expected?: string) => {
    await expect.poll(() => !frame().includes('Applying…'), { timeout: 6000 }).toBe(true);
    await new Promise<void>((done) => setImmediate(done));
    const before = output.length;
    stdin.write(bytes);
    if (expected)
      await expect
        .poll(() => (output.length > before ? frame() : ''), { timeout: 6000 })
        .toContain(expected);
    else await new Promise((done) => setTimeout(done, 90));
  };
  const home = async () => {
    await send('\u001b');
    await send('\u001b');
  };
  const command = async (text: string, expected: string) => {
    await home();
    await send(text, text);
    await send('\r', expected);
    await expect.poll(() => !frame().includes('Applying…')).toBe(true);
  };
  await expect.poll(frame, { timeout: 6000 }).toContain('identity r1');
  return {
    ...h,
    created,
    get exited() {
      return app.waitUntilExit();
    },
    relaunch: async () => {
      app.unmount();
      app.cleanup();
      output = '';
      stdin = makeInput();
      app = launch();
      await expect.poll(frame, { timeout: 6000 }).toContain('identity r1');
    },
    frame,
    send,
    home,
    command,
    close: async () => {
      app.unmount();
      app.cleanup();
      await h.close();
    },
  };
}
