import { describe, expect, it } from 'vitest';

import {
  sanitizedSubprocessEnvironment,
  selectInheritedEnvironment,
} from '../src/security/environment.js';

describe('subprocess environment boundaries', () => {
  it('inherits only operational variables and explicit values', () => {
    const source = {
      HOME: '/home/operator',
      PATH: '/usr/bin',
      NUAAI_AUDIT_SENTINEL: 'must-not-leak',
    };

    expect(sanitizedSubprocessEnvironment({ EXPLICIT_TOKEN: 'allowed' }, source)).toEqual({
      HOME: '/home/operator',
      PATH: '/usr/bin',
      EXPLICIT_TOKEN: 'allowed',
    });
  });

  it('selects only explicitly named inherited variables and skips missing names', () => {
    expect(
      selectInheritedEnvironment(['APP_TOKEN', 'MISSING'], {
        APP_TOKEN: 'approved',
        OTHER_TOKEN: 'blocked',
      }),
    ).toEqual({ APP_TOKEN: 'approved' });
  });
});
