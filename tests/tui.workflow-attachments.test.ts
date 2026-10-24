import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { workflowHarness } from './tui.workflow-harness.js';

it('completes file paths, persists attachments and sends exact bytes only on accepted submission', async () => {
  const ui = await workflowHarness();
  const path = join(ui.root, 'shipment notes.txt');
  await writeFile(path, 'Shipment Ω\nactual bytes');
  try {
    await expect.poll(ui.frame).toContain('Thread A');
    await ui.send(`/attach ${join(ui.root, 'shipment')}`, '/attach');
    await ui.send('\t', 'Attach file');
    await ui.send('\r', 'Attached shipment notes.txt');
    await ui.restart();
    await expect.poll(ui.frame).toContain('shipment notes.txt');
    ui.rejectRuns(true);
    await ui.send('\r', 'controlled rejection');
    expect(ui.frame()).toContain('shipment notes.txt');
    const failed = ui.requests.filter((request) => request.path === '/api/runs').at(-1);
    expect(failed?.body.attachments).toEqual([
      {
        name: 'shipment notes.txt',
        data: Buffer.from('Shipment Ω\nactual bytes').toString('base64'),
      },
    ]);
    ui.rejectRuns(false);
    await ui.send('\r', 'Run accepted');
    await expect.poll(ui.frame).not.toContain('Files:');
    const accepted = ui.requests.filter((request) => request.path === '/api/runs').at(-1);
    expect(accepted?.body.idempotencyKey).toBe(failed?.body.idempotencyKey);
    await ui.send(`/attach ${path} `);
    await ui.send('\r', 'Attached shipment notes.txt');
    await ui.send('\u001be', 'Pending attachments');
    await ui.send('\r', 'Attachment removed');
    expect(ui.frame()).not.toContain('Files:');
  } finally {
    await ui.close();
  }
});
