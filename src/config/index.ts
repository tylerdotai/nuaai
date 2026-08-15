import { resolve } from 'node:path';

import { harnessConfig } from '../../.config/harness.config.js';

export { harnessConfig };

export function workspaceDirectory(root = process.cwd()): string {
  return resolve(root, harnessConfig.workspaceDir);
}
