import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { workflowHarness } from './tui.workflow-harness.js';

it('recovers distinct thread drafts, cursor positions and sent history across navigation and restart', async () => {
  const ui = await workflowHarness();
  try {
    await expect.poll(ui.frame).toContain('Thread A');
    await ui.send('alpha', 'alpha');
    await ui.send('\u001b[D');
    await ui.send('\u001b[1;5C', 'Thread B');
    await ui.send('beta', 'beta');
    await ui.send('\u001b[1;5D', 'Thread A');
    await ui.send('X', 'alphXa');
    await ui.restart();
    await expect.poll(ui.frame).toContain('alphXa');
    await ui.send('\r', 'Run accepted');
    await ui.send('\u001b[A');
    expect(ui.frame()).not.toContain('alphXa');
    await ui.send('\u001b[1;3A', 'alphXa');
    await ui.send('\u001b[1;5C', 'Thread B');
    await expect.poll(ui.frame).toContain('beta');
    await ui.restart();
    await expect.poll(ui.frame).toContain('Thread B');
    await expect.poll(ui.frame).toContain('beta');
    await ui.send('\u001b[1;5D', 'Thread A');
    await ui.send('\u001b[1;3A', 'alphXa');
  } finally {
    await ui.close();
  }
});

it('keeps corrupt recovery warnings and actionable submission/request errors visible without overwriting or submitting', async () => {
  const ui = await workflowHarness();
  let path: string | undefined;
  let resumeHydration = () => {};
  try {
    await expect.poll(ui.frame).toContain('Thread A');
    await ui.send('recover me', 'recover me');
    await expect
      .poll(async () => {
        const names = await readdir(join(ui.root, '.nuaai'));
        const name = names.find((entry) => entry.startsWith('tui-drafts-'));
        if (!name) return null;
        const document = JSON.parse(await readFile(join(ui.root, '.nuaai', name), 'utf8'));
        return document.threads.a?.draft.text;
      })
      .toBe('recover me');
    const name = (await readdir(join(ui.root, '.nuaai'))).find((entry) =>
      entry.startsWith('tui-drafts-'),
    );
    if (!name) throw new Error('Missing recovery file');
    path = join(ui.root, '.nuaai', name);
    await writeFile(path, '{damaged');
    resumeHydration = ui.pauseHydration();
    const restarting = ui.restart();
    // Transport connection can precede the restored thread/composer. Release
    // the snapshot explicitly instead of treating Connected as input readiness.
    await expect.poll(ui.frame).toContain('Connected');
    expect(ui.frame()).not.toContain('Thread A');
    resumeHydration();
    await restarting;
    await expect.poll(ui.frame).toContain('Draft recovery:');
    await expect.poll(ui.frame).toContain('Thread A');
    await ui.waitForInput();
    await ui.send('new input', 'new input');
    await ui.send('\r', 'Pending submission could not be saved. No run was submitted.');
    expect(ui.frame()).toContain('Draft recovery:');
    expect(ui.frame()).toContain('new input');
    expect(ui.requests.filter((request) => request.path === '/api/runs')).toHaveLength(0);
    expect(await readFile(path, 'utf8')).toBe('{damaged');
    await ui.send('\u0015');
    ui.rejectSessionRefresh(true);
    await ui.send('/refresh', '/refresh');
    await ui.send('\r', 'controlled session refresh failure');
    expect(ui.frame()).toContain('Draft recovery:');
    expect(ui.requests.filter((request) => request.path === '/api/runs')).toHaveLength(0);
    expect(await readFile(path, 'utf8')).toBe('{damaged');
  } finally {
    resumeHydration();
    await ui.close();
    if (path) expect(await readFile(path, 'utf8')).toBe('{damaged');
  }
});
