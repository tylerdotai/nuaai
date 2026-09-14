import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type OutboundAddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
blockedAddresses.addAddress('::', 'ipv6');
blockedAddresses.addAddress('::1', 'ipv6');
for (const [network, prefix] of [
  ['64:ff9b:1::', 48],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blockedAddresses.addSubnet(network, prefix, 'ipv6');

function normalizedHostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function isReservedHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.home.arpa')
  );
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedAddresses.check(address, 'ipv4');
  if (family === 6) {
    const normalized = address.split('%', 1)[0].toLowerCase();
    const dottedMapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dottedMapped) return isPublicAddress(dottedMapped[1]);
    const hexadecimalMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexadecimalMapped) {
      const high = Number.parseInt(hexadecimalMapped[1], 16);
      const low = Number.parseInt(hexadecimalMapped[2], 16);
      return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return !blockedAddresses.check(normalized, 'ipv6');
  }
  return false;
}

const resolveAddresses: OutboundAddressResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export class PublicOutboundUrlPolicy {
  constructor(private readonly resolver: OutboundAddressResolver = resolveAddresses) {}

  async assertAllowed(value: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Browser URL must be a valid public http or https URL');
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Browser URL must use http or https');
    if (url.username || url.password) throw new Error('Browser URL must not contain credentials');
    const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (!['80', '443'].includes(effectivePort))
      throw new Error('Browser URL must use public HTTP ports 80 or 443');

    const hostname = normalizedHostname(url);
    if (!hostname || isReservedHostname(hostname))
      throw new Error('Browser URL must resolve to a public network destination');
    const literalFamily = isIP(hostname);
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await this.resolver(hostname);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
      throw new Error('Browser URL must resolve only to public network destinations');
    return url;
  }
}
