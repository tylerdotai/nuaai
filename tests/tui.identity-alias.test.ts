import { it } from 'vitest';
import { realTuiHarness } from './tui.real-harness.js';
it('opens a confirmation for documented /identity refresh instead of silently showing read-only status', async () => {
  const h = await realTuiHarness();
  try {
    await h.command('/identity refresh', 'Refresh session identity?');
  } finally {
    await h.close();
  }
}, 15000);
