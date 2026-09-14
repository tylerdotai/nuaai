import { describe, expect, it } from 'vitest';

import { PublicOutboundUrlPolicy } from '../src/security/outbound-url.js';

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('public outbound URL policy', () => {
  it('allows ordinary public HTTP and HTTPS destinations', async () => {
    const policy = new PublicOutboundUrlPolicy(publicResolver);

    await expect(policy.assertAllowed('https://example.com/path')).resolves.toMatchObject({
      hostname: 'example.com',
      pathname: '/path',
    });
    await expect(policy.assertAllowed('http://93.184.216.34/')).resolves.toMatchObject({
      hostname: '93.184.216.34',
    });
  });

  it.each([
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://172.16.1.2/',
    'http://192.168.1.2/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://localhost/',
    'http://service.internal/',
  ])('rejects local, private, and link-local destination %s', async (url) => {
    const policy = new PublicOutboundUrlPolicy(publicResolver);
    await expect(policy.assertAllowed(url)).rejects.toThrow('public network destination');
  });

  it('rejects private DNS answers, mixed public/private answers, credentials, and unsafe ports', async () => {
    const privatePolicy = new PublicOutboundUrlPolicy(async () => [
      { address: '192.168.1.20', family: 4 },
    ]);
    await expect(privatePolicy.assertAllowed('https://example.com')).rejects.toThrow(
      'public network destination',
    );

    const mixedPolicy = new PublicOutboundUrlPolicy(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(mixedPolicy.assertAllowed('https://example.com')).rejects.toThrow(
      'public network destination',
    );

    const policy = new PublicOutboundUrlPolicy(publicResolver);
    await expect(policy.assertAllowed('https://user:pass@example.com')).rejects.toThrow(
      'credentials',
    );
    await expect(policy.assertAllowed('https://example.com:8443')).rejects.toThrow('port');
  });
});
