import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { realTuiHarness } from './tui.real-harness.js';

it('creates and retrieves a durable instruction-only skill through actual TUI commands and authenticated daemon routes', async () => {
  const h = await realTuiHarness();
  try {
    await h.command(
      '/skill-create acceptance-guide|Check TUI_SKILL_READBACK_SENTINEL before delivery.',
      'Skill created',
    );
    const list = await h.api('/api/skills');
    const skill = list.body.skills.find((s: { name: string }) => s.name === 'acceptance-guide');
    expect(await readFile(skill.path, 'utf8')).toContain('TUI_SKILL_READBACK_SENTINEL');
    await h.command('/skill acceptance-guide', 'TUI_SKILL_READBACK_SENTINEL');
    await h.command('/skill missing-skill', 'Unknown skill');
  } finally {
    await h.close();
  }
}, 20000);
