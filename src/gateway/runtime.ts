import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { workspaceDirectory } from '../config/index.js';
import { createToken } from './token.js';

interface RuntimeIdentity {
  version: 1;
  secret: string;
  token: string;
}

export function ensureRuntimeIdentity(root: string): RuntimeIdentity {
  const path = resolve(workspaceDirectory(root), 'runtime.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as RuntimeIdentity;
  const secret = process.env.NUAAI_AUTH_SECRET?.trim() || randomBytes(32).toString('hex');
  const token = createToken(
    { sub: 'local-client', exp: Math.floor(Date.now() / 1000) + 2_592_000 },
    secret,
  );
  const identity: RuntimeIdentity = { version: 1, secret, token };
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return identity;
}
