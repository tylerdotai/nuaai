import { describe, expect, it } from 'vitest';

import { providerUnavailableNotice } from '../src/web/format.js';

describe('provider switch feedback', () => {
  it('scopes an unavailable optional provider while preserving the active runtime', () => {
    expect(
      providerUnavailableNotice(
        'Provider codex is unavailable: Linux sandbox preflight failed',
        'codex',
        { name: 'ollama', model: 'local' },
      ),
    ).toBe('Codex unavailable · local remains active');
  });

  it('leaves unrelated switch failures as actionable errors', () => {
    expect(
      providerUnavailableNotice('Model unknown is not available from provider codex', 'codex', {
        name: 'ollama',
        model: 'local',
      }),
    ).toBeUndefined();
  });

  it('does not hide failure of the currently active provider', () => {
    expect(
      providerUnavailableNotice('Provider codex is unavailable: runtime failed', 'codex', {
        name: 'codex',
        model: 'gpt-test',
      }),
    ).toBeUndefined();
  });
});
