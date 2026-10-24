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

it('reports corrupt recovered drafts persistently and never overwrites the damaged recovery file', async () => {
  const ui = await workflowHarness();
  try {
    await expect.poll(ui.frame).toContain('Thread A');
    await ui.send('recover me', 'recover me');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const name = (await readdir(join(ui.root, '.nuaai'))).find((entry) =>
      entry.startsWith('tui-drafts-'),
    );
    if (!name) throw new Error('Missing recovery file');
    const path = join(ui.root, '.nuaai', name);
    await writeFile(path, '{damaged');
    await ui.restart();
    await expect.poll(ui.frame).toContain('Draft recovery:');
    await ui.send('new input', 'new input');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await readFile(path, 'utf8')).toBe('{damaged');
  } finally {
    await ui.close();
  }
});
