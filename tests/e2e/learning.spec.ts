import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createBrowserPairingToken } from '../../src/gateway/runtime.js';

test('learning mode controls show verified daemon state and survive a browser reload', async ({
  page,
}, testInfo) => {
  const root = process.env.NUAAI_E2E_ROOT;
  if (!root) throw new Error('An isolated E2E root is required');
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(root))}`);
  await expect(page.locator('.connection')).toContainText('Connected');
  await page.locator('.primary-nav [aria-controls="view-memory"]').click();
  await testInfo.attach('memory-panel', {
    body: await page.screenshot({ path: testInfo.outputPath('memory-panel.png') }),
    contentType: 'image/png',
  });
  const mode = page.getByRole('combobox', { name: 'Agent learning' });
  try {
    await expect(mode).toHaveValue('automatic');
    await mode.selectOption('manual');
    await expect(mode).toBeEnabled();
    await expect(mode).toHaveValue('manual');
    const configuration = JSON.parse(await readFile(join(root, '.nuaai', 'config.json'), 'utf8'));
    expect(configuration.learning.mode).toBe('manual');
    await page.reload();
    await expect(page.locator('.connection')).toContainText('Connected');
    await page.locator('.primary-nav [aria-controls="view-memory"]').click();
    await expect(mode).toHaveValue('manual');
    await mode.selectOption('off');
    await expect(mode).toBeEnabled();
    await expect(mode).toHaveValue('off');
    const actual = await page.request.get('/api/memory/learning');
    expect(await actual.json()).toMatchObject({ available: true, enabled: false, mode: 'off' });
  } finally {
    const restored = await page.request.post('/api/memory/learning', {
      data: { mode: 'automatic' },
    });
    expect(restored.ok()).toBe(true);
    const actual = await page.request.get('/api/memory/learning');
    expect((await actual.json()).mode).toBe('automatic');
  }
});
