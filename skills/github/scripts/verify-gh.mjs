#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function run(args) {
  return spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 2_000_000,
    timeout: 30_000,
  });
}

const auth = run(['auth', 'status']);
if (auth.error) {
  console.error(`GitHub CLI authentication check failed: ${auth.error.message}`);
  process.exit(1);
}
if (auth.status !== 0) {
  console.error('GitHub CLI authentication check failed.');
  process.exit(auth.status || 1);
}

const repositories = run([
  'repo',
  'list',
  '--limit',
  '1000',
  '--json',
  'nameWithOwner,description,isPrivate,isArchived,updatedAt,url',
]);
if (repositories.error) {
  console.error(`GitHub repository query failed: ${repositories.error.message}`);
  process.exit(1);
}
if (repositories.status !== 0) {
  console.error('GitHub repository query failed.');
  process.exit(repositories.status || 1);
}

let rows;
try {
  rows = JSON.parse(repositories.stdout);
} catch {
  console.error('GitHub repository query returned invalid JSON.');
  process.exit(1);
}
if (!Array.isArray(rows)) {
  console.error('GitHub repository query returned a non-array result.');
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      authenticated: true,
      repositoryCount: rows.length,
      repositories: rows,
    },
    null,
    2,
  ),
);
