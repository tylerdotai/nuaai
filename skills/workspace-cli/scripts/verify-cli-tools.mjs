#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const checks = [
  ['node', ['--version']],
  ['npm', ['--version']],
  ['git', ['--version']],
  ['gh', ['--version']],
  ['ollama', ['--version']],
];
const results = [];
for (const [command, args] of checks) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 200_000,
    timeout: 10_000,
  });
  results.push({
    command,
    available: !result.error && result.status === 0,
    version: result.status === 0 ? result.stdout.trim().split('\n')[0] : undefined,
    error: result.error?.message,
  });
}
console.log(JSON.stringify({ checks: results }, null, 2));
if (results.some((result) => !result.available)) process.exitCode = 1;
