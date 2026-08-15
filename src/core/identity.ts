import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_FILE_BYTES = 12_000;
const IDENTITY_FILES = ['AGENTS.md', 'SOUL.md'] as const;

function readBounded(path: string): string {
  try {
    const value = readFileSync(path, 'utf8');
    if (Buffer.byteLength(value, 'utf8') <= MAX_FILE_BYTES) return value.trim();
    return `${Buffer.from(value, 'utf8').subarray(0, MAX_FILE_BYTES).toString('utf8')}\n[truncated by NUAAI]`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export function loadSessionIdentity(root: string): string {
  const sections = IDENTITY_FILES.flatMap((name) => {
    const content = readBounded(resolve(root, name));
    return content ? [`## ${name}\n${content}`] : [];
  });
  return sections.length
    ? `Session identity and workspace instructions loaded at session start:\n\n${sections.join('\n\n')}`
    : 'No AGENTS.md or SOUL.md was present at session start.';
}
