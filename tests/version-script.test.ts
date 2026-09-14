import { describe, expect, it } from 'vitest';

import { validateVersionTagPolicy } from '../scripts/version-policy.mjs';

describe('release version tag policy', () => {
  it('allows an untagged release-candidate branch', () => {
    expect(
      validateVersionTagPolicy({ version: '1.0.0', exactTags: [], githubRef: 'refs/heads/main' }),
    ).toBe('v1.0.0');
  });

  it('requires an exact local tag on HEAD to match the package version', () => {
    expect(() => validateVersionTagPolicy({ version: '1.0.0', exactTags: ['v0.1.0'] })).toThrow(
      'v0.1.0 does not match v1.0.0',
    );
  });

  it('requires a GitHub tag build to match the package version', () => {
    expect(() =>
      validateVersionTagPolicy({
        version: '1.0.0',
        exactTags: [],
        githubRef: 'refs/tags/v1.0.1',
      }),
    ).toThrow('v1.0.1 does not match v1.0.0');
  });
});
