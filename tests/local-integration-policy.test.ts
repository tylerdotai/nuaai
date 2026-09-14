import { describe, expect, it } from 'vitest';

import { localIntegrationSelection } from '../scripts/local-integration-policy.mjs';

describe('local integration service selection', () => {
  it('starts only services required by explicit flags', () => {
    expect(localIntegrationSelection(['--matrix'])).toEqual({
      matrix: true,
      search: false,
      browser: false,
      services: ['synapse'],
    });
    expect(localIntegrationSelection(['--search'])).toEqual({
      matrix: false,
      search: true,
      browser: false,
      services: ['searxng', 'crawl4ai'],
    });
    expect(localIntegrationSelection(['--browser'])).toEqual({
      matrix: false,
      search: false,
      browser: true,
      services: ['flaresolverr'],
    });
  });

  it('preserves the direct-script all-integrations default and rejects unknown flags', () => {
    expect(localIntegrationSelection([]).services).toEqual([
      'synapse',
      'searxng',
      'crawl4ai',
      'flaresolverr',
    ]);
    expect(() => localIntegrationSelection(['--everything'])).toThrow('Unknown integration flag');
  });
});
