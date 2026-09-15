import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { createBrowserPairingToken } from '../../src/gateway/runtime.js';

test('v1 conversation UI completes durable, structured, queued, failed, and responsive flows', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  const e2eRoot = process.env.NUAAI_E2E_ROOT;
  if (!e2eRoot) throw new Error('NUAAI_E2E_ROOT is required');
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(e2eRoot))}`);
  await expect(page.locator('.brand strong')).toHaveText('NUAAI');
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    'manifest.webmanifest',
  );

  await page.getByRole('button', { name: /Commands/ }).click();
  const commandPalette = page.getByRole('dialog', { name: 'Commands' });
  await expect(commandPalette).toBeVisible();
  await expect(commandPalette.getByRole('button', { name: /New conversation/ })).toBeVisible();
  await expect(commandPalette.getByRole('button', { name: /New thread/ })).toBeVisible();
  await expect(commandPalette.getByRole('button', { name: /Focus composer/ })).toBeVisible();
  await expect(commandPalette.getByRole('button', { name: /Refresh runtime/ })).toBeVisible();
  await expect(commandPalette.getByRole('button', { name: /Cancel active run/ })).toBeDisabled();
  await commandPalette.getByRole('button', { name: 'Close commands' }).click();

  const initialSessionCount = await page.locator('.session-row').count();
  await page.locator('.new-conversation-button').click();
  await expect(page.locator('.session-row')).toHaveCount(initialSessionCount + 1);
  const selectedSession = page.locator('.session-row.selected');
  await expect(selectedSession).toContainText('Current');
  const createdSessionTitle = await selectedSession.locator('strong').textContent();
  expect(createdSessionTitle).toBeTruthy();
  expect(createdSessionTitle).not.toMatch(/^Session \d+$/);

  const search = page.getByPlaceholder('Search conversations');
  await search.fill(createdSessionTitle ?? '');
  await expect(page.locator('.session-row')).toHaveCount(1);
  await search.clear();
  await expect(page.locator('.session-group h2').first()).toContainText('Today');

  const composer = page.getByPlaceholder('Message NUAAI…');
  await expect(composer).toBeEnabled();
  await expect(page.getByLabel('Model')).toContainText(/deterministic/i);
  const capabilityControl = page.locator('.composer-popover').filter({ hasText: 'Operator' });
  await capabilityControl.locator('summary').click();
  await expect(capabilityControl).toContainText('Run approved commands');
  const contextControl = page.locator('.composer-context');
  await contextControl.locator('summary').click();
  await expect(contextControl).toContainText('Thread history');
  await expect(contextControl).toContainText('Automatic memory');
  await contextControl.locator('summary').click();
  await capabilityControl.locator('summary').click();

  await composer.fill(Array.from({ length: 9 }, (_, index) => `line ${index}`).join('\n'));
  await expect
    .poll(() => composer.evaluate((element) => Number.parseFloat(element.style.height)))
    .toBeGreaterThan(52);
  await page.getByRole('button', { name: 'Expand composer' }).click();
  await expect(page.locator('.composer')).toHaveClass(/composer-expanded/);
  await page.getByRole('button', { name: 'Collapse composer' }).click();

  const draft = `durable draft ${Date.now()}`;
  await composer.fill(draft);
  await page.reload();
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  await page
    .locator('.session-row')
    .filter({ hasText: createdSessionTitle ?? '' })
    .click();
  await expect(composer).toHaveValue(draft);
  await composer.clear();

  const composingText = `IME ${Date.now()}`;
  await composer.fill(composingText);
  await composer.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
  });
  await expect(page.locator('.message-user').filter({ hasText: composingText })).toHaveCount(0);
  await expect(composer).toHaveValue(composingText);
  await composer.clear();

  await page.getByRole('button', { name: 'New thread' }).click();
  const threadSelect = page.getByLabel('Thread');
  await expect(threadSelect).toBeVisible();
  await expect(threadSelect.locator('option')).toHaveCount(2);

  const selectionSentinel = `selection sentinel ${Date.now()}`;
  await composer.fill(selectionSentinel);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message-user').filter({ hasText: selectionSentinel })).toBeVisible();
  await expect(page.locator('.message-assistant').last()).toContainText(
    /deterministic test response/i,
    {
      timeout: 30_000,
    },
  );

  const currentThreadId = await threadSelect.inputValue();
  const alternateThreadId = await threadSelect
    .locator('option')
    .evaluateAll(
      (options, current) =>
        options
          .map((option) => (option as HTMLOptionElement).value)
          .find((value) => value !== current),
      currentThreadId,
    );
  if (!alternateThreadId) throw new Error('Rapid-switch test requires an alternate thread');
  let markDelayedRequestStarted: () => void = () => undefined;
  const delayedRequestStarted = new Promise<void>((resolve) => {
    markDelayedRequestStarted = resolve;
  });
  let releaseDelayedRequests: () => void = () => undefined;
  const delayedRequestsReleased = new Promise<void>((resolve) => {
    releaseDelayedRequests = resolve;
  });
  await page.route('**/api/threads/**', async (route) => {
    if (route.request().url().includes(encodeURIComponent(alternateThreadId))) {
      markDelayedRequestStarted();
      await delayedRequestsReleased;
    }
    await route.continue();
  });
  await threadSelect.selectOption(alternateThreadId);
  await delayedRequestStarted;
  const staleMessageCount = await page
    .locator('.message-user')
    .filter({ hasText: selectionSentinel })
    .count();
  releaseDelayedRequests();
  expect(staleMessageCount).toBe(0);
  await threadSelect.selectOption(currentThreadId);
  await expect(threadSelect).toHaveValue(currentThreadId);
  await expect(page.locator('.message-user').filter({ hasText: selectionSentinel })).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.unroute('**/api/threads/**');

  await composer.fill('browser smoke');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message-assistant').last()).toContainText(
    'NUAAI deterministic test response',
    { timeout: 30_000 },
  );
  await expect(page.locator('.message-live')).toHaveCount(0);

  const beforeToolResponses = await page.locator('.message-assistant').count();
  await composer.fill('browser tool smoke');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message-assistant')).toHaveCount(beforeToolResponses + 1, {
    timeout: 30_000,
  });
  const toolResponse = page.locator('.message-assistant').last();
  await expect(toolResponse).toContainText('NUAAI deterministic test response', {
    timeout: 30_000,
  });
  await toolResponse.getByRole('button', { name: 'Inspect run activity' }).click();
  await expect(toolResponse).toContainText('workspace.list');
  await expect(toolResponse.locator('[data-activity-id]')).toHaveCount(1);

  const beforeWriteResponses = await page.locator('.message-assistant').count();
  await composer.fill('browser write smoke');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message-assistant')).toHaveCount(beforeWriteResponses + 1, {
    timeout: 30_000,
  });
  const writeResponse = page.locator('.message-assistant').last();
  const approvalInbox = page.getByRole('region', { name: 'Action approvals' });
  await expect(approvalInbox).toBeVisible({ timeout: 30_000 });
  const writeApproval = approvalInbox
    .locator('.approval-card')
    .filter({ hasText: 'workspace.write' });
  await expect(writeApproval).toContainText('work-sample-output.txt');
  await expect(writeApproval.locator('.approval-hash')).toHaveText(/^[a-f0-9]{64}$/);
  await writeApproval.getByRole('button', { name: 'Approve once' }).click();
  await expect(writeApproval).toHaveCount(0, { timeout: 30_000 });
  await expect(writeResponse).toContainText('NUAAI deterministic test response', {
    timeout: 30_000,
  });
  await writeResponse.getByRole('button', { name: 'Inspect run activity' }).click();
  await expect(writeResponse).toContainText('workspace.write');
  await expect(writeResponse.getByRole('region', { name: 'Run artifacts' })).toContainText(
    'work-sample-output.txt',
  );
  await expect
    .poll(async () => readFile(join(e2eRoot, 'work-sample-output.txt'), 'utf8').catch(() => null), {
      timeout: 30_000,
    })
    .toBe('agentic-write-ok');

  await composer.fill('browser markdown smoke');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const markdownResponse = page.locator('.message-assistant').last();
  await expect(markdownResponse.getByRole('heading', { name: 'Verified output' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(markdownResponse.getByRole('cell', { name: 'Passed' })).toBeVisible();
  await expect(markdownResponse.locator('code.language-ts')).toContainText('const answer = 42;');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const copyCode = markdownResponse.getByRole('button', { name: 'Copy code block' });
  await copyCode.click();
  await expect(copyCode).toHaveText('Copied');
  await expect(markdownResponse.locator('script')).toHaveCount(0);
  await expect(markdownResponse).not.toContainText('alert("nope")');

  await composer.fill('browser failure smoke');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const failedResponse = page.locator('.message-assistant').last();
  await expect(failedResponse.locator('[data-status="failed"]')).toContainText(
    'Deterministic browser failure',
    { timeout: 30_000 },
  );
  const beforeRetryResponses = await page.locator('.message-assistant').count();
  let markResumeStarted: () => void = () => undefined;
  const resumeStarted = new Promise<void>((resolve) => {
    markResumeStarted = resolve;
  });
  let releaseResume: () => void = () => undefined;
  const resumeReleased = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  await page.route('**/api/runs/**/resume', async (route) => {
    markResumeStarted();
    await resumeReleased;
    await route.continue();
  });
  await failedResponse.getByRole('button', { name: 'Retry failed run' }).click();
  await resumeStarted;
  await threadSelect.selectOption(alternateThreadId);
  await expect(threadSelect).toHaveValue(alternateThreadId);
  releaseResume();
  await page.waitForTimeout(150);
  await expect(page.locator('.connection')).not.toContainText('Retry started');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.unroute('**/api/runs/**/resume');
  await threadSelect.selectOption(currentThreadId);
  await expect(threadSelect).toHaveValue(currentThreadId);
  await expect(page.locator('.message-assistant')).toHaveCount(beforeRetryResponses + 1, {
    timeout: 30_000,
  });
  await expect(page.locator('.message-assistant').last()).toContainText(
    'NUAAI deterministic test response',
    { timeout: 30_000 },
  );

  await page.setViewportSize({ width: 1440, height: 600 });
  await composer.fill('browser cancel smoke');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message-live')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.composer-action')).toHaveAttribute('aria-label', 'Stop current run');
  const messages = page.locator('.messages');
  await expect
    .poll(() => messages.evaluate((element) => element.scrollHeight - element.clientHeight > 160))
    .toBe(true);
  await messages.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(page.getByRole('button', { name: 'Jump to newest response' })).toBeVisible({
    timeout: 10_000,
  });
  expect(await messages.evaluate((element) => element.scrollTop)).toBeLessThan(80);
  await page.getByRole('button', { name: 'Jump to newest response' }).click();
  await expect
    .poll(() =>
      messages.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(4);

  const queuedPrompt = `queued follow-up ${Date.now()}`;
  const beforeQueuedResponses = await page.locator('.message-assistant:not(.message-live)').count();
  await composer.fill(queuedPrompt);
  await expect(page.locator('.composer-followup-modes')).toContainText('Send next');
  await page.locator('.composer-action').click();
  await expect(page.locator('.composer-queue')).toContainText(queuedPrompt);
  await expect(page.locator('.composer-action')).toHaveAttribute('aria-label', 'Stop current run');
  await page.locator('.composer-action').click();
  await expect(page.locator('.message-user').filter({ hasText: queuedPrompt })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect
    .poll(() => page.locator('.message-assistant:not(.message-live)').count())
    .toBeGreaterThan(beforeQueuedResponses);
  await expect(page.locator('.message-assistant').last()).toContainText(
    'NUAAI deterministic test response',
    { timeout: 30_000 },
  );
  await expect(page.locator('.composer-queue')).toHaveCount(0);

  await composer.fill('browser cancel smoke');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message-live')).toBeVisible({ timeout: 30_000 });
  const interruptPrompt = `interrupt follow-up ${Date.now()}`;
  const beforeInterruptResponses = await page
    .locator('.message-assistant:not(.message-live)')
    .count();
  await composer.fill(interruptPrompt);
  await page
    .locator('.composer-followup-modes')
    .getByRole('button', { name: 'Interrupt and send' })
    .click();
  await expect(page.locator('.composer-action')).toHaveAttribute(
    'aria-label',
    'Interrupt and send',
  );
  await page.locator('.composer-action').click();
  await expect(page.locator('.message-user').filter({ hasText: interruptPrompt })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect
    .poll(() => page.locator('.message-assistant:not(.message-live)').count())
    .toBeGreaterThan(beforeInterruptResponses);
  await expect(page.locator('.message-assistant').last()).toContainText(
    'NUAAI deterministic test response',
    { timeout: 30_000 },
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopGeometry = await page.evaluate(() => {
    const composerBox = document.querySelector('.composer-input-row')?.getBoundingClientRect();
    const assistantBoxes = Array.from(document.querySelectorAll('.message-assistant')).map(
      (element) => element.getBoundingClientRect(),
    );
    return {
      width: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      composerBottom: composerBox?.bottom ?? Number.POSITIVE_INFINITY,
      composerWidth: composerBox?.width ?? Number.POSITIVE_INFINITY,
      assistantMaxWidth: Math.max(...assistantBoxes.map((box) => box.width)),
    };
  });
  expect(desktopGeometry.width).toBe(desktopGeometry.clientWidth);
  expect(desktopGeometry.height).toBe(desktopGeometry.clientHeight);
  expect(desktopGeometry.composerBottom).toBeLessThanOrEqual(900);
  expect(desktopGeometry.composerWidth).toBeLessThanOrEqual(864);
  expect(desktopGeometry.assistantMaxWidth).toBeLessThanOrEqual(864);

  await page.reload();
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  await page
    .locator('.session-row')
    .filter({ hasText: createdSessionTitle ?? '' })
    .click();
  await expect(page.locator('.message-user').filter({ hasText: 'browser smoke' })).toHaveCount(1);
  await expect(page.locator('[data-status="failed"]')).toContainText(
    'Deterministic browser failure',
  );
  const inspectButtons = page.getByRole('button', { name: 'Inspect run activity' });
  await expect(inspectButtons).toHaveCount(2);
  await inspectButtons.first().click();
  await expect(page.getByText('workspace.list', { exact: true })).toBeVisible();

  await page
    .locator('.primary-nav')
    .getByRole('tab', { name: /Memory/ })
    .click();
  await expect(page.getByRole('tabpanel')).toContainText('Only information intentionally saved');
  await expect(page.locator('[aria-label="Memory records"]')).toBeVisible();

  await page
    .locator('.primary-nav')
    .getByRole('tab', { name: /System/ })
    .click();
  await expect(page.getByRole('tabpanel')).toContainText('Provider health');
  await expect(page.locator('[aria-label="Skills"]')).toBeVisible();
  await expect(page.locator('[aria-label="Plugins"]')).toBeVisible();

  await page
    .locator('.primary-nav')
    .getByRole('tab', { name: /Automations/ })
    .click();
  await expect(page.getByRole('tabpanel')).toContainText('Durable background work');
  const scheduleName = `Browser schedule ${Date.now()}`;
  await page.getByLabel('Schedule name').fill(scheduleName);
  await page.getByLabel('Schedule agent input').fill('Say hello.');
  await page.getByRole('button', { name: 'Create automation' }).click();
  const automationCard = page.locator('.automation-card').filter({ hasText: scheduleName });
  await expect(automationCard).toBeVisible();
  await automationCard.getByRole('button', { name: 'Run now' }).click();
  await expect(automationCard).toContainText('completed', { timeout: 30_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileTabs = page.locator('.mobile-nav').getByRole('tab');
  await expect(mobileTabs).toHaveCount(3);
  await expect(page.locator('.mobile-nav')).not.toContainText('Automate');
  await page.locator('.mobile-nav').getByRole('tab', { name: 'Chat' }).click();
  await page.getByRole('button', { name: 'Open conversations' }).click();
  const drawer = page.getByRole('dialog', { name: 'Conversations' });
  await expect(drawer).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.classList.contains('new-conversation-button')),
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Open conversations' })).toBeFocused();
  await page.getByRole('button', { name: 'Open conversations' }).click();
  await drawer.getByRole('tab', { name: /Automations/ }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole('tabpanel')).toContainText('Durable background work');
  await page.locator('.mobile-nav').getByRole('tab', { name: 'Chat' }).click();

  const mobileGeometry = await page.evaluate(() => {
    const composerBox = document.querySelector('.composer')?.getBoundingClientRect();
    const navBox = document.querySelector('.mobile-nav')?.getBoundingClientRect();
    const codeBoxes = Array.from(document.querySelectorAll('.code-block')).map((element) =>
      element.getBoundingClientRect(),
    );
    return {
      width: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      composerBottom: composerBox?.bottom ?? Number.POSITIVE_INFINITY,
      navTop: navBox?.top ?? 0,
      navBottom: navBox?.bottom ?? Number.POSITIVE_INFINITY,
      widestCodeRight: Math.max(0, ...codeBoxes.map((box) => box.right)),
    };
  });
  expect(mobileGeometry.width).toBe(mobileGeometry.clientWidth);
  expect(mobileGeometry.height).toBe(mobileGeometry.clientHeight);
  expect(mobileGeometry.composerBottom).toBeLessThanOrEqual(mobileGeometry.navTop);
  expect(mobileGeometry.navBottom).toBeLessThanOrEqual(844);
  expect(mobileGeometry.widestCodeRight).toBeLessThanOrEqual(390);
  await expect(page.getByRole('button', { name: /Commands/ })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('NUAAI local token');
  expect(browserErrors).toEqual([]);
});

test('HTTP polling surfaces paused approvals when WebSocket approval events are lost', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const e2eRoot = process.env.NUAAI_E2E_ROOT;
  if (!e2eRoot) throw new Error('NUAAI_E2E_ROOT is required');
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const text = String(message);
      if (text.includes('approvals.invalidated') || text.includes('approval.requested')) return;
      socket.send(message);
    });
  });
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(e2eRoot))}`);
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  await expect(page.locator('.composer textarea')).toBeVisible({ timeout: 30_000 });

  const composer = page.locator('.composer textarea');
  await composer.fill('browser write smoke');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  const approvalInbox = page.getByRole('region', { name: 'Action approvals' });
  await expect(approvalInbox).toBeVisible({ timeout: 10_000 });
  const writeApproval = approvalInbox
    .locator('.approval-card')
    .filter({ hasText: 'workspace.write' });
  await expect(writeApproval).toContainText('work-sample-output.txt');
  await writeApproval.getByRole('button', { name: 'Approve once' }).click();
  await expect(page.locator('.message-assistant').last()).toContainText(
    'NUAAI deterministic test response',
    { timeout: 30_000 },
  );
});

test('a failed optional provider switch keeps the active runtime healthy', async ({ page }) => {
  const e2eRoot = process.env.NUAAI_E2E_ROOT;
  if (!e2eRoot) throw new Error('NUAAI_E2E_ROOT is required');
  let switchFailed = false;

  await page.route('**/api/providers', async (route) => {
    const response = await route.fetch();
    const catalog = (await response.json()) as {
      active: { name: string; model: string };
      providers: Array<{ name: string; available: boolean; detail: string; models?: string[] }>;
    };
    await route.fulfill({
      response,
      json: {
        ...catalog,
        providers: [
          ...catalog.providers,
          {
            name: 'codex',
            available: !switchFailed,
            detail: switchFailed
              ? 'Linux sandbox preflight failed: user namespaces unavailable'
              : 'Runtime preflight pending',
            models: ['gpt-test'],
          },
        ],
      },
    });
  });
  await page.route('**/api/providers/switch', async (route) => {
    switchFailed = true;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error:
          'Provider codex is unavailable: Linux sandbox preflight failed: user namespaces unavailable',
      }),
    });
  });

  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(e2eRoot))}`);
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  await page
    .locator('.primary-nav')
    .getByRole('tab', { name: /System/ })
    .click();

  const codex = page.locator('.provider-card').filter({ hasText: 'Codex' });
  await codex.getByRole('button', { name: 'gpt-test' }).click();

  await expect(page.locator('.connection')).toContainText('Codex unavailable', {
    timeout: 10_000,
  });
  await expect(codex.locator('.provider-title strong')).toHaveText('Offline');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.system-section .section-heading-row').first()).toContainText(
    /deterministic · deterministic/i,
  );
});

test('mobile safe-area space keeps chat and system UI outside device insets', async ({ page }) => {
  const e2eRoot = process.env.NUAAI_E2E_ROOT;
  if (!e2eRoot) throw new Error('NUAAI_E2E_ROOT is required');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(e2eRoot))}`);
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-area-top', '47px');
    document.documentElement.style.setProperty('--safe-area-bottom', '34px');
  });

  for (const destination of ['Chat', 'System']) {
    await page.locator('.mobile-nav').getByRole('tab', { name: destination }).click();
    const geometry = await page.evaluate(() => {
      const workspace = document.querySelector('.workspace')?.getBoundingClientRect();
      const header = document.querySelector('.app-header')?.getBoundingClientRect();
      const navigation = document.querySelector('.mobile-nav')?.getBoundingClientRect();
      return {
        headerBottom: header?.bottom ?? 0,
        headerHeight: header?.height ?? 0,
        workspaceTop: workspace?.top ?? Number.POSITIVE_INFINITY,
        workspaceBottom: workspace?.bottom ?? Number.POSITIVE_INFINITY,
        navigationTop: navigation?.top ?? 0,
        navigationBottom: navigation?.bottom ?? Number.POSITIVE_INFINITY,
        navigationHeight: navigation?.height ?? 0,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });

    expect(geometry.headerHeight).toBeGreaterThanOrEqual(99);
    expect(geometry.workspaceTop).toBeGreaterThanOrEqual(geometry.headerBottom);
    expect(geometry.navigationHeight).toBeGreaterThanOrEqual(90);
    expect(geometry.workspaceBottom).toBeLessThanOrEqual(geometry.navigationTop);
    expect(geometry.navigationBottom).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.documentWidth).toBe(geometry.viewportWidth);
  }
  await expect(page.getByRole('tabpanel')).toContainText('Skills');
});

test('a long multi-turn response survives reload without draft concatenation or clipping', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  const e2eRoot = process.env.NUAAI_E2E_ROOT;
  if (!e2eRoot) throw new Error('NUAAI_E2E_ROOT is required');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(e2eRoot))}`);
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  await page.getByRole('button', { name: /Commands/ }).click();
  await page
    .getByRole('dialog', { name: 'Commands' })
    .getByRole('button', { name: /New conversation/ })
    .click();
  await expect(page.locator('.connection')).toContainText('New conversation ready', {
    timeout: 30_000,
  });

  const composer = page.getByPlaceholder('Message NUAAI…');
  await composer.fill('browser long stream smoke');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const assistant = page.locator('.message-assistant').last();
  await expect(assistant).toContainText('Durable long response', { timeout: 30_000 });
  await expect(assistant).toContainText('Evidence line 100', { timeout: 30_000 });
  await expect(assistant).not.toContainText('PROVISIONAL SHOULD DISAPPEAR');

  await page.reload();
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  await expect(page.locator('.message-assistant').last()).toContainText('Evidence line 100', {
    timeout: 30_000,
  });
  await expect(page.locator('.message-assistant').last()).not.toContainText(
    'PROVISIONAL SHOULD DISAPPEAR',
  );
  await expect(page.locator('.message-assistant').last()).toContainText(
    'FINAL_LONG_RESPONSE_SENTINEL',
    { timeout: 60_000 },
  );
  await expect(page.getByText(/tool-turn limit was reached/i)).toHaveCount(0);
  await expect(page.locator('.message-assistant')).toHaveCount(1);

  await page.reload();
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  const persisted = page.locator('.message-assistant').last();
  await expect(persisted).toContainText('FINAL_LONG_RESPONSE_SENTINEL', { timeout: 30_000 });
  const dimensions = await persisted.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflow: getComputedStyle(element).overflow,
  }));
  expect(dimensions.clientHeight).toBe(dimensions.scrollHeight);
  expect(dimensions.overflow).not.toBe('hidden');
  expect(browserErrors).toEqual([]);
});

test('a stale terminal poll failure cannot surface in a newly selected thread', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const e2eRoot = process.env.NUAAI_E2E_ROOT;
  if (!e2eRoot) throw new Error('NUAAI_E2E_ROOT is required');
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(e2eRoot))}`);
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  await page.locator('.new-conversation-button').click();
  await expect(page.locator('.connection')).toContainText('New conversation ready', {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'New thread' }).click();
  await expect(page.locator('.connection')).toContainText('New thread ready', {
    timeout: 30_000,
  });

  const composer = page.getByPlaceholder('Message NUAAI…');
  const threadSelect = page.getByLabel('Thread');
  const originalThreadId = await threadSelect.inputValue();
  const threadIds = await threadSelect
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  const alternateThreadId = threadIds.find((threadId) => threadId !== originalThreadId);
  if (!alternateThreadId) throw new Error('Expected an alternate thread for the poll race');
  let markPollStarted: () => void = () => undefined;
  const pollStarted = new Promise<void>((resolve) => {
    markPollStarted = resolve;
  });
  let releasePoll: () => void = () => undefined;
  const pollRelease = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  let heldPoll = false;
  await page.route('**/api/runs/**', async (route) => {
    if (route.request().method() !== 'GET' || heldPoll) {
      await route.continue();
      return;
    }
    heldPoll = true;
    markPollStarted();
    await pollRelease;
    try {
      await route.abort('failed');
    } catch {
      // The fixed client aborts the stale request during selection cleanup.
    }
  });

  await composer.fill('browser cancel smoke');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop current run' })).toBeVisible({
    timeout: 30_000,
  });
  await pollStarted;
  await threadSelect.selectOption(alternateThreadId);
  await expect(threadSelect).toHaveValue(alternateThreadId);
  releasePoll();
  await page.waitForTimeout(250);
  await expect(page.getByRole('alert')).toHaveCount(0);

  await threadSelect.selectOption(originalThreadId);
  await expect(page.getByRole('button', { name: 'Stop current run' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Stop current run' }).click();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible({
    timeout: 30_000,
  });
});

test('an accepted run is not restored to the composer when its refresh fails', async ({ page }) => {
  const e2eRoot = process.env.NUAAI_E2E_ROOT;
  if (!e2eRoot) throw new Error('NUAAI_E2E_ROOT is required');
  await page.goto(`/#token=${encodeURIComponent(createBrowserPairingToken(e2eRoot))}`);
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 30_000 });
  await page.locator('.new-conversation-button').click();
  await expect(page.locator('.connection')).toContainText('New conversation ready', {
    timeout: 30_000,
  });
  const composer = page.getByPlaceholder('Message NUAAI…');
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  const prompt = `accepted refresh failure ${Date.now()}`;
  let runAccepted = false;
  await page.route('**/api/runs', async (route) => {
    const response = await route.fetch();
    runAccepted = true;
    await route.fulfill({ response });
  });
  await page.route('**/api/threads/**', (route) =>
    runAccepted ? route.abort('failed') : route.continue(),
  );

  await composer.fill(prompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  await expect(page.getByRole('alert')).toContainText(
    'Run accepted, but conversation refresh failed',
  );
  await expect(composer).toHaveValue('');
});

test('a transient pairing failure still removes the fragment and requires a new link', async ({
  page,
}) => {
  await page.route('**/auth/pair', (route) => route.abort('failed'));
  await page.goto('/#token=transient-pairing-token');

  const alert = page.getByRole('alert');
  await expect(alert.getByText('Pair this device', { exact: true })).toBeVisible();
  await expect(alert).toContainText('Pairing could not be completed');
  await expect(alert).toContainText('generate a new pairing link');
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).hash).toBe('');
});

test('an invalid pairing fragment is removed and replaced with new-link guidance', async ({
  page,
}) => {
  await page.goto('/#token=invalid-pairing-token');

  const alert = page.getByRole('alert');
  await expect(alert.getByText('Pair this device', { exact: true })).toBeVisible();
  await expect(alert).toContainText('generate a new pairing link');
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).hash).toBe('');
});
