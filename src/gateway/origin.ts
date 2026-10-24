/** Local deployment trust only, not evidence that the peer is Tailscale.
 * A trusted loopback reverse proxy MUST overwrite X-Forwarded-Proto. */
export function effectiveRequestOrigin(
  peer: string | undefined,
  rawHeaders: readonly string[],
): string {
  const values = (name: string): string[] => {
    const found: string[] = [];
    for (let index = 0; index < rawHeaders.length; index += 2)
      if (rawHeaders[index].toLowerCase() === name) found.push(rawHeaders[index + 1]);
    return found;
  };
  const hosts = values('host');
  const host = hosts[0];
  if (hosts.length !== 1 || !host || /[\s/\\@?#]/u.test(host))
    throw new Error('Invalid request host');
  const protocols = values('x-forwarded-proto');
  const trusted = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const scheme = trusted && protocols.length === 1 && protocols[0] === 'https' ? 'https' : 'http';
  let url: URL;
  try {
    url = new URL(`${scheme}://${host}`);
  } catch {
    throw new Error('Invalid request host');
  }
  if (url.username || url.password || url.pathname !== '/' || !url.hostname)
    throw new Error('Invalid request host');
  return url.origin;
}
