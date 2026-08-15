import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = packageJson.version;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version: ${version}`);
}

const lockPath = resolve(root, 'package-lock.json');
if (existsSync(lockPath)) {
  const lockfile = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (lockfile.packages?.['']?.version !== version) {
    throw new Error('package-lock.json version does not match package.json');
  }
}

const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-version:refname'], {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);
const expectedTag = `v${version}`;
if (tags[0] !== expectedTag) {
  throw new Error(`Latest Git tag ${tags[0] ?? '(none)'} does not match ${expectedTag}`);
}

process.stdout.write(`NUAI version ${version} matches ${expectedTag}\n`);
