import { expect, test } from '@playwright/test';
import { createBrowserPairingToken } from '../../src/gateway/runtime.js';

test('web attachments carry bytes into the accepted run and clear only after acceptance', async ({
  page,
}) => {
  const root = process.env.NUAAI_E2E_ROOT;
  if (!root) throw new Error('NUAAI_E2E_ROOT is required');
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(root))}`);
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/sessions') && response.request().method() === 'POST',
  );
  await page.locator('.new-conversation-button').click();
  const created = await (await createdResponse).json();
  const composer = page.getByPlaceholder('Message NUAAI…');
  await expect(composer).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('BLUEBIRD shipment record'),
  });
  await composer.fill('Summarize the attached record. Do not use tools.');
  const request = page.waitForRequest(
    (req) => req.url().endsWith('/api/runs') && req.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const sent = (await request).postDataJSON();
  expect(sent.attachments).toEqual([
    { name: 'notes.txt', data: Buffer.from('BLUEBIRD shipment record').toString('base64') },
  ]);
  await expect(page.locator('.attachment-chip')).toHaveCount(0);
  await expect(
    page.locator('.message-user').filter({ hasText: 'BLUEBIRD shipment record' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator('.message-user').filter({ hasText: 'BLUEBIRD shipment record' }),
  ).toBeVisible();
  const deleted = await page.request.delete(`/api/sessions/${created.session.id}`);
  expect(deleted.ok()).toBe(true);
  const remaining = await (await page.request.get('/api/sessions')).json();
  expect(
    remaining.sessions.some((session: { id: string }) => session.id === created.session.id),
  ).toBe(false);
});
