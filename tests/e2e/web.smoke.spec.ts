import { readFile } from 'node:fs/promises';
import { createServer, request as proxyRequest } from 'node:http';
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

  const initialSessions = await page.request.get('/api/sessions');
  const initialSessionCount = (await initialSessions.json()).sessions.length;
  await expect(page.locator('.session-row')).toHaveCount(initialSessionCount);
  await page.locator('.new-conversation-button').click();
  await expect(page.locator('.session-row')).toHaveCount(initialSessionCount + 1);
  const selectedSession = page.locator('.session-row-wrap.selected');
  await expect(selectedSession).toContainText('Current');
  const createdSessionTitle = await selectedSession.locator('.session-row strong').textContent();
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
  await expect(page.getByText('workspace.list', { exact: true })).toBeVisible();

  await page
    .locator('.primary-nav')
    .getByRole('tab', { name: /Memory/ })
    .click();
  await expect(page.getByRole('tabpanel')).toContainText('selectively learned project knowledge');
  await expect(page.getByRole('combobox', { name: 'Agent learning' })).toBeEnabled();
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
  const automationCard = page
    .getByLabel('Schedules', { exact: true })
    .locator('.schedule-row')
    .filter({ has: page.getByRole('heading', { name: scheduleName, exact: true }) });
  await expect(automationCard).toBeVisible();
  const scheduleResponse = await page.request.get('/api/schedules');
  expect(scheduleResponse.ok()).toBe(true);
  const { schedules } = (await scheduleResponse.json()) as {
    schedules: Array<{ id: string; name: string; agentInput: string }>;
  };
  const createdSchedule = schedules.find((schedule) => schedule.name === scheduleName);
  expect(createdSchedule?.agentInput).toBe('Say hello.');
  await automationCard.getByRole('button', { name: 'Run', exact: true }).click();
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/tasks');
        expect(response.ok()).toBe(true);
        const { tasks } = (await response.json()) as {
          tasks: Array<{
            scheduleId: string | null;
            status: string;
            payload: { agentInput?: string };
          }>;
        };
        const completed = tasks.find(
          (task) => task.scheduleId === createdSchedule?.id && task.status === 'completed',
        );
        return completed && { status: completed.status, input: completed.payload.agentInput };
      },
      { timeout: 30_000 },
    )
    .toEqual({ status: 'completed', input: 'Say hello.' });

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

test('HTTP polling surfaces paused approvals when SSE approval events are lost', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const e2eRoot = process.env.NUAAI_E2E_ROOT;
  if (!e2eRoot) throw new Error('NUAAI_E2E_ROOT is required');
  await page.route(/\/api\/agent\/stream/, async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has('drop')) {
      url.searchParams.set('drop', 'approval.requested');
      await route.continue({ url: url.toString() });
      return;
    }
    await route.continue();
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

  const codex = page.locator('.provider-row').filter({ hasText: /codex/i });
  await codex.getByRole('button', { name: 'gpt-test' }).click();

  await expect(page.locator('.connection')).toContainText('Codex unavailable', {
    timeout: 10_000,
  });
  await expect(codex.locator('.provider-status')).toContainText('Offline');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.current-model').first()).toContainText(
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

test('SSE reconnect recovers missed output with the native cursor and deduplicates replay at the app mount', async ({
  page,
  baseURL,
}) => {
  const e2eRoot = process.env.NUAAI_E2E_ROOT;
  if (!e2eRoot) throw new Error('NUAAI_E2E_ROOT is required');
  const runId = 'reconnect-fixture';
  const cursor = 1_000_000_003;
  const reconnectHeaders: Array<string | undefined> = [];
  let connections = 0;
  let admissions = 0;
  let disconnectStream: () => void = () => undefined;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', baseURL);
    if (url.pathname === `/nuaai/api/runs/${runId}`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'running' }));
      return;
    }
    if (url.pathname === '/nuaai/api/runs' && request.method === 'POST') admissions += 1;
    if (url.pathname !== '/nuaai/api/agent/stream' || !request.headers.cookie) {
      const proxy = proxyRequest(
        url,
        { method: request.method, headers: request.headers },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      proxy.on('error', () => response.destroy());
      request.pipe(proxy);
      return;
    }
    expect(request.headers.cookie).toContain('nuaai_token=');
    expect(url.searchParams.has('token')).toBe(false);
    const sessionId = url.searchParams.get('session_id');
    const detail = await fetch(`${baseURL}/nuaai/api/sessions/${sessionId}`, {
      headers: { cookie: request.headers.cookie ?? '' },
    });
    expect(detail.ok).toBe(true);
    const { threads } = await detail.json();
    const threadId = threads[0].id;
    const event = (id: number, type: string, payload: Record<string, unknown>) =>
      `id: ${id}\nevent: ${type === 'model.delta' ? 'token' : 'status'}\ndata: ${JSON.stringify({
        id,
        event: { id, type, sessionId, threadId, runId, createdAt: 1, payload },
      })}\n\n`;
    connections += 1;
    if (connections === 1) {
      // A finite SSE response simulates a dropped stream after its last event.
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        [
          'retry: 100\n\n',
          event(cursor - 1, 'run.started', {}),
          event(cursor, 'model.delta', { text: 'Before disconnect. ' }),
        ].join(''),
      );
      return;
    }
    const header = request.headers['last-event-id'] as string | undefined;
    reconnectHeaders.push(header);
    // Match the daemon contract: only a header cursor requests missed events.
    // Include an overlapping record to exercise the client's monotonic dedupe.
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    disconnectStream = () => {
      response.end();
    };
    response.write(
      [
        'retry: 100\n\n',
        header === String(cursor)
          ? [
              event(cursor, 'model.delta', { text: 'Before disconnect. ' }),
              event(cursor + 1, 'model.delta', { text: 'Recovered missed output.' }),
            ].join('')
          : ': no replay requested\n\n',
      ].join(''),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected isolated proxy port');
  try {
    await page.goto(
      `http://127.0.0.1:${address.port}/nuaai/#token=${encodeURIComponent(createBrowserPairingToken(e2eRoot))}`,
    );
    await expect(page.locator('.connection')).toContainText('Connected');
    if ((await page.locator('.session-row').count()) === 0)
      await page.locator('.new-conversation-button').click();
    const assistant = page.locator('.message-assistant').last();
    await expect(assistant).toContainText('Before disconnect.');
    await expect.poll(() => reconnectHeaders).toContain(String(cursor));
    await expect(assistant).toContainText('Before disconnect. Recovered missed output.');
    await expect(assistant).not.toContainText('Before disconnect. Before disconnect.');
    expect(reconnectHeaders[0]).toBe(String(cursor));
    expect(connections).toBeGreaterThanOrEqual(2);
    expect(admissions).toBe(0);
    // Removing the real session cookie makes the daemon reject native reconnect.
    // A terminal 401 must surface pairing guidance instead of endless retries.
    await page.context().clearCookies();
    disconnectStream();
    await expect(page.getByRole('alert')).toContainText('Pair this device to continue.');
    await expect(page.locator('.connection')).toContainText('Offline');
    expect(admissions).toBe(0);
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
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
    'Run accepted, but client reconciliation failed',
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
