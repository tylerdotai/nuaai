import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateVersionTagPolicy } from './version-policy.mjs';

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

const exactTags = execFileSync('git', ['tag', '--points-at', 'HEAD', '--list', 'v*'], {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);
const expectedTag = validateVersionTagPolicy({
  version,
  exactTags,
  githubRef: process.env.GITHUB_REF,
});
const taggedRelease = exactTags.length > 0 || process.env.GITHUB_REF?.startsWith('refs/tags/');

process.stdout.write(
  taggedRelease
    ? `NUAAI version ${version} matches ${expectedTag}\n`
    : `NUAAI version ${version} is internally consistent; release tag is not present at HEAD\n`,
);
