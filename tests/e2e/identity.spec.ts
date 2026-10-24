import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createBrowserPairingToken } from '../../src/gateway/runtime.js';

test('web identity metadata and refresh preserve private snapshots while both files reach the real daemon provider boundary', async ({
  page,
}, testInfo) => {
  const root = process.env.NUAAI_E2E_ROOT;
  if (!root) throw new Error('NUAAI_E2E_ROOT is required');
  const project = await mkdtemp(join(root, 'identity-project-'));
  await mkdir(join(project, 'nested'));
  await writeFile(join(project, 'SOUL.md'), 'WEB_IDENTITY_SOUL_MARKER');
  await writeFile(join(project, 'AGENTS.md'), 'WEB_IDENTITY_AGENTS_MARKER_1');
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(root))}`);
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30000 });
  const created = await page.request.post('/api/sessions', {
    data: {
      title: 'Identity E2E project',
      sourceKey: `web:identity-${Date.now()}`,
      workspaceRoot: project,
    },
  });
  expect(created.ok()).toBe(true);
  const first = await created.json();
  await page.reload();
  await page.locator('.session-row').filter({ hasText: 'Identity E2E project' }).click();
  const sendProbe = async (version: number) => {
    const composer = page.getByPlaceholder('Message NUAAI…');
    await composer.fill(`browser identity smoke ${version}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.message-assistant').last()).toContainText(
      `Verified instruction snapshot ${version} at provider boundary.`,
    );
  };
  await sendProbe(1);
  await page.getByRole('button', { name: 'Instruction sources', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Session instruction sources' });
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())?.x).toBeGreaterThan(16);
  await expect(panel).toContainText('Revision 1');
  await expect(panel).toContainText('project/SOUL.md');
  await expect(panel).toContainText('project/AGENTS.md');
  await expect(panel).not.toContainText('WEB_IDENTITY_SOUL_MARKER');
  expect(
    JSON.stringify(
      await (await page.request.get(`/api/sessions/${first.session.id}/identity`)).json(),
    ),
  ).not.toContain('WEB_IDENTITY_AGENTS_MARKER');
  await page.screenshot({
    path: testInfo.outputPath('web-identity-status.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('button', { name: 'Close instruction sources' }).click();
  await page.getByRole('button', { name: /^Commands/ }).click();
  await page
    .getByRole('dialog', { name: 'Commands', exact: true })
    .getByRole('button', { name: /^Instruction sources/ })
    .click();
  await expect(panel).toContainText('Revision 1');
  const mobileBox = await panel.boundingBox();
  expect(mobileBox?.width).toBeLessThanOrEqual(358);
  await panel
    .getByRole('button', { name: 'Refresh identity', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('web-identity-status-mobile.png'),
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await panel.getByRole('button', { name: 'Close instruction sources' }).click();
  await writeFile(join(project, 'AGENTS.md'), 'WEB_IDENTITY_AGENTS_MARKER_2');
  await sendProbe(1);
  const newSession = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/sessions') && response.request().method() === 'POST',
  );
  await page.locator('.new-conversation-button').click();
  const second = await (await newSession).json();
  await sendProbe(2);
  await page.locator('.session-row').filter({ hasText: 'Identity E2E project' }).click();
  await page.getByRole('button', { name: 'Instruction sources', exact: true }).click();
  await panel.getByRole('button', { name: 'Refresh identity', exact: true }).click();
  await panel.getByRole('button', { name: 'Reload instruction files', exact: true }).click();
  await expect(panel).toContainText('Revision 2');
  await panel.getByRole('button', { name: 'Close instruction sources' }).click();
  await sendProbe(2);
  const sessions = await (await page.request.get('/api/sessions')).json();
  expect(JSON.stringify(sessions)).not.toContain('WEB_IDENTITY_SOUL_MARKER');
  for (const id of [first.session.id, second.session.id])
    expect((await page.request.delete(`/api/sessions/${id}`)).ok()).toBe(true);
});
