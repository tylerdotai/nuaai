import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { DatabaseStore } from '../memory/db.js';
import { decryptSecret, encryptSecret, rotateSecret } from './encryption.js';

function loadOrCreateMasterKey(root: string): string {
  const configured = process.env.NUAI_MASTER_KEY;
  if (configured?.trim()) return configured;
  const directory = resolve(root, '.nuai', 'secrets');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'master.key');
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const key = randomBytes(32).toString('hex');
    writeFileSync(path, `${key}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    return key;
  }
}

export class SecretsManager {
  private readonly masterKey: string;
  constructor(
    private readonly store: DatabaseStore,
    root: string,
  ) {
    this.masterKey = loadOrCreateMasterKey(root);
  }
  set(name: string, plaintext: string): void {
    if (!name.trim() || !plaintext) throw new Error('Secret name and value are required');
    this.store.putSecret(name, encryptSecret(plaintext, this.masterKey));
  }
  get(name: string): string | undefined {
    const value = this.store.getSecretCiphertext(name);
    return value ? decryptSecret(value, this.masterKey) : undefined;
  }
  has(name: string): boolean {
    return this.store.hasSecret(name);
  }
  delete(name: string): void {
    this.store.deleteSecret(name);
  }
  rotate(oldKey: string, newKey: string): void {
    for (const name of this.listNames()) {
      const ciphertext = this.store.getSecretCiphertext(name);
      if (ciphertext) this.store.putSecret(name, rotateSecret(ciphertext, oldKey, newKey));
    }
  }
  listNames(): string[] {
    return (
      this.store.database.raw.prepare('SELECT name FROM secrets ORDER BY name').all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  }
}
