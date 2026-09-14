#!/usr/bin/env node

import { startDaemon } from '../dist/daemon.js';

try {
  await startDaemon();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
