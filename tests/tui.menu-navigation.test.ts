import { expect, it } from 'vitest';
import { loadTuiPreferences } from '../src/ui/tui-preferences.js';
import { workflowHarness } from './tui.workflow-harness.js';

it('applies a setting inside its menu and returns to chat only on Escape, preserving the composer', async () => {
  const ui = await workflowHarness();
  try {
    await expect.poll(ui.frame).toContain('Thread A');
    await ui.send('KEEP_MENU_DRAFT', 'KEEP_MENU_DRAFT');
    await ui.send('\u001bs', 'Settings');
    await ui.send('spacing');
    await ui.send('\r', 'Terminal preference saved');
    expect(ui.frame()).toContain('Settings');
    expect(ui.frame()).toContain('Transcript spacing · compact');
    expect((await loadTuiPreferences(ui.root)).compact).toBe(true);
    await ui.send('\u001b', 'KEEP_MENU_DRAFT');
    expect(ui.frame()).not.toContain('Search: spacing');
  } finally {
    await ui.close();
  }
});

it('Escape walks back through nested menus with their query/selection retained', async () => {
  const ui = await workflowHarness();
  try {
    await expect.poll(ui.frame).toContain('Thread A');
    await ui.send('KEEP_NESTED_DRAFT');
    await ui.send('\u001bs', 'Settings');
    await ui.send('Provider');
    await ui.send('\r', 'Choose provider');
    await ui.send('fixture');
    await ui.send('\r', 'Choose model');
    await ui.send('\u001b', 'Choose provider');
    expect(ui.frame()).toContain('Search: fixture');
    await ui.send('\u001b', 'Settings');
    expect(ui.frame()).toContain('Search: Provider');
    await ui.send('\u001b', 'KEEP_NESTED_DRAFT');
  } finally {
    await ui.close();
  }
});
