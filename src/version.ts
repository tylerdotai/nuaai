import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface PackageMetadata {
  name: string;
  version: string;
}

export function readPackageMetadata(): PackageMetadata {
  const packageUrl = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(packageUrl), 'utf8')) as PackageMetadata;
}

export function getVersion(): string {
  return readPackageMetadata().version;
}
