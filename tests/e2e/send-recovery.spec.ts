import { expect, test } from '@playwright/test';
import { createBrowserPairingToken } from '../../src/gateway/runtime.js';

test('a rejected send never replaces the newer draft typed while the request was pending', async ({
  page,
}) => {
  const root = process.env.NUAAI_E2E_ROOT;
  if (!root) throw new Error('An isolated E2E root is required');
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(root))}`);
  await expect(page.locator('.connection')).toContainText('Connected');
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/sessions') && response.request().method() === 'POST',
  );
  await page.locator('.new-conversation-button').click();
  const created = await (await createdResponse).json();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending = false;
  await page.route('**/api/runs', async (route) => {
    pending = true;
    await gate;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Controlled admission failure' }),
    });
  });
  try {
    const composer = page.getByPlaceholder('Message NUAAI…');
    await composer.fill('Original rejected request');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => pending).toBe(true);
    await composer.fill('New draft that must survive the old failure');
    release();
    await expect(page.getByRole('alert')).toContainText('Controlled admission failure');
    await expect(composer).toHaveValue('New draft that must survive the old failure');
  } finally {
    release();
    await page.request.delete(`/api/sessions/${created.session.id}`);
  }
});

test('unsent attachments survive section navigation and remain owned by their conversation', async ({
  page,
}) => {
  const root = process.env.NUAAI_E2E_ROOT;
  if (!root) throw new Error('An isolated E2E root is required');
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(root))}`);
  await expect(page.locator('.connection')).toContainText('Connected');
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/sessions') && response.request().method() === 'POST',
  );
  await page.locator('.new-conversation-button').click();
  const created = await (await createdResponse).json();
  const other = await (
    await page.request.post('/api/sessions', {
      data: { title: 'Attachment isolation B', sourceKey: `web:attachment-${created.session.id}` },
    })
  ).json();
  try {
    await page.locator('input[type=file]').setInputFiles({
      name: 'owner-a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('OWNER_A_PRIVATE_FIXTURE'),
    });
    await expect(page.locator('.attachment-chip')).toContainText('owner-a.txt');
    await page.getByRole('tab', { name: /^Memory/ }).click();
    await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await expect(page.locator('.attachment-chip')).toContainText('owner-a.txt');
    await page.getByRole('button', { name: 'Refresh runtime', exact: true }).click();
    await page.locator('.session-row').filter({ hasText: 'Attachment isolation B' }).click();
    await expect(page.locator('.attachment-chip')).toHaveCount(0);
    await page.locator('input[type=file]').setInputFiles({
      name: 'owner-b.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('OWNER_B_PRIVATE_FIXTURE'),
    });
    await page.locator('.session-row').filter({ hasText: created.session.title }).click();
    await expect(page.locator('.attachment-chip')).toContainText('owner-a.txt');
    await expect(page.locator('.attachment-chip')).not.toContainText('owner-b.txt');
  } finally {
    await page.request.delete(`/api/sessions/${created.session.id}`);
    await page.request.delete(`/api/sessions/${other.session.id}`);
  }
});

test('retry after a committed run loses its response survives a browser reload without creating a second run', async ({
  page,
}) => {
  test.setTimeout(25_000);
  const root = process.env.NUAAI_E2E_ROOT;
  if (!root) throw new Error('An isolated E2E root is required');
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(root))}`);
  await expect(page.locator('.connection')).toContainText('Connected');
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/sessions') && response.request().method() === 'POST',
  );
  await page.locator('.new-conversation-button').click();
  const created = await (await createdResponse).json();
  const input = 'Transport replay acceptance sentinel. Do not use tools.';
  let firstId = '';
  let dropped = false;
  await page.route('**/api/runs', async (route) => {
    if (!dropped) {
      dropped = true;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      firstId = (await response.json()).id;
      await route.abort('failed');
    } else await route.continue();
  });
  try {
    const composer = page.getByPlaceholder('Message NUAAI…');
    await composer.fill(input);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/fetch/i);
    await expect(composer).toHaveValue(input);
    await page.reload();
    await expect(page.locator('.connection')).toContainText('Connected');
    await expect(composer).toHaveValue(input);
    const retriedResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/runs') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const retried = await (await retriedResponse).json();
    expect(retried.id).toBe(firstId);
    await expect(composer).toHaveValue('');
    const presentation = await (
      await page.request.get(`/api/threads/${created.thread.id}/presentation`)
    ).json();
    expect(
      presentation.messages
        .filter((message: { role: string }) => message.role === 'user')
        .map((message: { markdown: string }) => message.markdown),
    ).toEqual([input]);
  } finally {
    await page.request.delete(`/api/sessions/${created.session.id}`);
  }
});
