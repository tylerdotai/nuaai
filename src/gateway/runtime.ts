import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { workspaceDirectory } from '../config/index.js';
import { createToken, validateToken } from './token.js';

interface RuntimeIdentity {
  version: 1;
  secret: string;
  token: string;
}

export function ensureRuntimeIdentity(root: string): RuntimeIdentity {
  const path = resolve(workspaceDirectory(root), 'runtime.json');
  let existing: Partial<RuntimeIdentity> | undefined;
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeIdentity>;
      if (
        existing.version === 1 &&
        typeof existing.secret === 'string' &&
        typeof existing.token === 'string' &&
        validateToken(existing.token, existing.secret)
      )
        return existing as RuntimeIdentity;
    } catch {
      existing = undefined;
    }
  }
  const preservedSecret =
    typeof existing?.secret === 'string' && existing.secret.length >= 32
      ? existing.secret
      : undefined;
  const secret =
    process.env.NUAAI_AUTH_SECRET?.trim() || preservedSecret || randomBytes(32).toString('hex');
  const token = createToken(
    { sub: 'local-client', exp: Math.floor(Date.now() / 1000) + 2_592_000 },
    secret,
  );
  const identity: RuntimeIdentity = { version: 1, secret, token };
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return identity;
}

export function createBrowserPairingToken(root: string, now = Date.now()): string {
  const identity = ensureRuntimeIdentity(root);
  return createToken(
    {
      sub: 'browser-pairing',
      purpose: 'browser-pairing',
      exp: Math.floor(now / 1_000) + 300,
    },
    identity.secret,
    now,
  );
}
