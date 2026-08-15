import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(masterKey: string): Buffer {
  if (!masterKey.trim()) {
    throw new Error('Master key is required');
  }
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

export function encryptSecret(plaintext: string, masterKey: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string, masterKey: string): string {
  const parts = encoded.split('.');
  const [version, ivValue, tagValue, ciphertextValue] = parts;
  if (parts.length !== 4 || version !== VERSION || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Invalid encrypted secret format');
  }
  const iv = Buffer.from(ivValue, 'base64url');
  const tag = Buffer.from(tagValue, 'base64url');
  const ciphertext = Buffer.from(ciphertextValue, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Invalid encrypted secret payload');
  }
  const decipher = createDecipheriv(ALGORITHM, deriveKey(masterKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function rotateSecret(encoded: string, oldMasterKey: string, newMasterKey: string): string {
  return encryptSecret(decryptSecret(encoded, oldMasterKey), newMasterKey);
}
