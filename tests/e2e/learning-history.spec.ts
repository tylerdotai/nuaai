import { expect, test } from '@playwright/test';
import { createBrowserPairingToken } from '../../src/gateway/runtime.js';

test('automatic learning shows actual provenance, separates retired history, and undoes a correction from the browser', async ({
  page,
}, testInfo) => {
  const root = process.env.NUAAI_E2E_ROOT;
  if (!root) throw new Error('An isolated E2E root is required');
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(root))}`);
  await expect(page.locator('.connection')).toContainText('Connected');
  const created = await page.request.post('/api/sessions', {
    data: { title: 'Browser learning acceptance', workspaceRoot: root },
  });
  expect(created.ok()).toBe(true);
  const { thread } = await created.json();
  const notes = async (): Promise<
    Array<{ id: string; content: string; metadata: { knowledge?: { state?: string } } }>
  > => {
    const response = await page.request.get('/api/memory');
    expect(response.ok()).toBe(true);
    return (await response.json()).memories;
  };
  for (const color of ['blue', 'green']) {
    const accepted = await page.request.post('/api/runs', {
      data: {
        threadId: thread.id,
        input: `I prefer ${color} controls for the browser learning acceptance project.`,
      },
    });
    expect(accepted.ok()).toBe(true);
    await expect
      .poll(
        async () =>
          (await notes()).find(
            (note) => note.content === `Browser acceptance project prefers ${color} controls.`,
          )?.metadata.knowledge?.state,
      )
      .toBe('active');
  }
  await page.reload();
  await expect(page.locator('.connection')).toContainText('Connected');
  await page.locator('.primary-nav [aria-controls="view-memory"]').click();
  const active = page.getByLabel('Memory records', { exact: true });
  const green = active
    .locator('.memory-row')
    .filter({ hasText: 'Browser acceptance project prefers green controls.' });
  await expect(green).toContainText('Learned automatically');
  await expect(active).not.toContainText('Browser acceptance project prefers blue controls.');
  await green.getByText('Evidence and scope', { exact: true }).click();
  await expect(green).toContainText(
    'I prefer green controls for the browser learning acceptance project.',
  );
  await expect(green).toContainText(root);
  await testInfo.attach('learned-note', {
    body: await page.screenshot({ path: testInfo.outputPath('learned-note.png') }),
    contentType: 'image/png',
  });
  await green.getByRole('button', { name: 'Undo learning', exact: true }).click();
  await expect(active).toContainText('Browser acceptance project prefers blue controls.');
  await expect(active).not.toContainText('Browser acceptance project prefers green controls.');
  const rows = await notes();
  expect(
    rows.find((note) => note.content === 'Browser acceptance project prefers blue controls.')
      ?.metadata.knowledge?.state,
  ).toBe('active');
  expect(
    rows.find((note) => note.content === 'Browser acceptance project prefers green controls.')
      ?.metadata.knowledge?.state,
  ).toBe('disabled');
  await page.getByText('Learning history', { exact: true }).click();
  await expect(page.getByLabel('Retired learning')).toContainText(
    'Browser acceptance project prefers green controls.',
  );
});
