import { describe, expect, it } from 'vitest';
import { effectiveRequestOrigin } from '../src/gateway/origin.js';

describe('effective request origin trust boundary', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'trusts exact HTTPS from loopback peer %s only',
    (peer) => {
      expect(
        effectiveRequestOrigin(peer, ['Host', 'nuaai.test:1234', 'X-Forwarded-Proto', 'https']),
      ).toBe('https://nuaai.test:1234');
    },
  );
  it.each([undefined, '192.0.2.1', '127.0.0.2', '::ffff:192.0.2.1', 'localhost'])(
    'does not trust forwarded scheme from %s',
    (peer) => {
      expect(
        effectiveRequestOrigin(peer, ['host', 'nuaai.test:1234', 'x-forwarded-proto', 'https']),
      ).toBe('http://nuaai.test:1234');
    },
  );
  it.each(['http', 'HTTPS', ' https', 'https ', 'https,http', 'https, https', 'javascript'])(
    'does not upgrade malformed/non-exact protocol %s',
    (value) => {
      expect(
        effectiveRequestOrigin('127.0.0.1', ['host', '[::1]:1234', 'x-forwarded-proto', value]),
      ).toBe('http://[::1]:1234');
    },
  );
  it('ignores forwarded host and rejects ambiguous actual Host', () => {
    expect(
      effectiveRequestOrigin('127.0.0.1', [
        'host',
        'actual.test',
        'x-forwarded-host',
        'forged.test',
        'Forwarded',
        'host=evil.test;proto=https',
      ]),
    ).toBe('http://actual.test');
    expect(
      effectiveRequestOrigin('127.0.0.1', [
        'host',
        'actual.test',
        'x-forwarded-proto',
        'https',
        'X-Forwarded-Proto',
        'https',
      ]),
    ).toBe('http://actual.test');
    expect(() =>
      effectiveRequestOrigin('127.0.0.1', ['host', 'actual.test', 'Host', 'evil.test']),
    ).toThrow('Invalid request host');
    for (const host of ['', 'a/b', 'user@a', 'a?x', 'a#x', 'a b', 'a\\b', 'a:invalid'])
      expect(() => effectiveRequestOrigin('127.0.0.1', ['host', host])).toThrow(
        'Invalid request host',
      );
    expect(() => effectiveRequestOrigin('127.0.0.1', [])).toThrow('Invalid request host');
  });
});
