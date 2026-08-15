import { expect, test } from '@playwright/test';

test('built web client creates a session and renders a live daemon run', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('header h1')).toHaveText('NUAAI');
  const status = page.locator('.status');
  await expect(status).toContainText('Connected', { timeout: 30_000 });

  const initialSessionCount = await page.locator('.session').count();
  await page.getByRole('button', { name: '+ New session' }).click();
  await expect(page.locator('.session')).toHaveCount(initialSessionCount + 1);
  await expect(page.locator('.session.selected strong')).toHaveText(/Session \d+/);
  await expect(page.locator('.session.selected')).toBeVisible();
  const createdSessionTitle = await page.locator('.session.selected strong').textContent();
  expect(createdSessionTitle).toBeTruthy();
  await expect(page.getByText('ACTIVE THREAD', { exact: true })).toBeVisible();

  const composer = page.getByPlaceholder('Ask NUAAI anything…');
  await expect(composer).toBeEnabled();
  await composer.fill('browser smoke');
  await page.getByRole('button', { name: 'Send ↗' }).click();

  await expect(page.locator('.message.assistant').last()).toContainText(
    'NUAAI deterministic test response',
    {
      timeout: 30_000,
    },
  );

  await composer.fill('browser tool smoke');
  await page.getByRole('button', { name: 'Send ↗' }).click();
  await expect(page.locator('.tool-activity')).toContainText('workspace.list', {
    timeout: 30_000,
  });

  await composer.fill('browser cancel smoke');
  await page.getByRole('button', { name: 'Send ↗' }).click();
  await expect(page.getByRole('button', { name: 'Cancel run' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel run' }).click();
  await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);

  await page.reload();
  await page
    .locator('.session')
    .filter({ hasText: createdSessionTitle ?? '' })
    .click();
  await expect(page.locator('.message.user').filter({ hasText: 'browser smoke' })).toHaveCount(1);
  await expect(page.getByText('persistent', { exact: true })).toBeVisible();

  for (const [tab, label] of [
    ['memory', 'Memory records'],
    ['skills', 'Skills'],
    ['plugins', 'Plugins'],
  ] as const) {
    await page.getByRole('button', { name: new RegExp(`^${tab}`) }).click();
    await expect(page.locator('main h2')).toHaveText(tab[0].toUpperCase() + tab.slice(1));
    await expect(page.locator(`[aria-label="${label}"]`)).toBeVisible();
  }

  await page.getByRole('button', { name: /^schedules/ }).click();
  await expect(page.locator('main h2')).toHaveText('Schedules');
  const scheduleName = `Browser schedule ${Date.now()}`;
  await page.getByLabel('Schedule name').fill(scheduleName);
  await page.getByLabel('Schedule agent input').fill('browser scheduled run');
  await page.getByRole('button', { name: 'Create manual schedule' }).click();
  const scheduleCard = page.locator('.schedule-card').filter({ hasText: scheduleName });
  await expect(scheduleCard).toBeVisible();
  await scheduleCard.getByRole('button', { name: 'Trigger' }).click();
  await expect(scheduleCard).toContainText('completed', { timeout: 30_000 });
  await expect(page.locator('body')).not.toContainText('NUAAI local token');
});
