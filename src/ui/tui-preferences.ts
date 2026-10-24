import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface TuiPreferences {
  compact: boolean;
  toolDetails: boolean;
}
export const defaultTuiPreferences: TuiPreferences = { compact: false, toolDetails: false };

export async function loadTuiPreferences(root: string): Promise<TuiPreferences> {
  try {
    const value = JSON.parse(await readFile(resolve(root, '.nuaai/tui.json'), 'utf8'));
    return { compact: value.compact === true, toolDetails: value.toolDetails === true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaultTuiPreferences };
    throw error;
  }
}

export async function saveTuiPreferences(root: string, value: TuiPreferences): Promise<void> {
  const path = resolve(root, '.nuaai/tui.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
