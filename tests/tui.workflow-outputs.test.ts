import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { workflowHarness } from './tui.workflow-harness.js';

it('exports the complete paginated conversation and copies response/code via explicit keyboard actions', async () => {
  const ui = await workflowHarness({
    a: [
      { id: 'old', role: 'user', markdown: 'Earlier question UNIQUE' },
      {
        id: 'answer',
        role: 'assistant',
        markdown: 'Answer UNIQUE\n```ts\nconst result = 42;\n```',
      },
    ],
  });
  try {
    await expect.poll(ui.frame).toContain('Thread A');
    await ui.send('\u0012');
    await ui.send('keep this', 'keep this');
    await ui.send('\u001bo', 'Conversation outputs');
    await ui.send('Answer UNIQUE', 'Search: Answer UNIQUE');
    await ui.send('\r', 'Response actions');
    await ui.send('Copy code', 'Copy code');
    await ui.send('\r', 'Clipboard request sent');
    expect(ui.terminalOutput()).toContain(
      `\u001b]52;c;${Buffer.from('const result = 42;').toString('base64')}\u0007`,
    );
    expect(ui.frame()).toContain('Response actions');
    await ui.send('\u001b', 'Conversation outputs');
    await ui.send('\u001b', 'keep this');
    await ui.send('\u001bx', 'Export saved:');
    const match = ui.frame().match(/Export saved: ([^\n]+)/u);
    if (!match) throw new Error('Missing export path');
    const content = await readFile(resolve(ui.root, match[1].trim()), 'utf8');
    expect(content).toContain('Earlier question UNIQUE');
    expect(content).toContain('Answer UNIQUE');
    expect(content).toContain('const result = 42;');
    expect(ui.frame()).toContain('keep this');
  } finally {
    await ui.close();
  }
});
