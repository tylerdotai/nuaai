import type { Dir } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';

export interface DiscoveryOptions {
  maxDepth?: number;
  maxFiles?: number;
  maxEntries?: number;
  signal?: AbortSignal;
  skipDirectory?: (relativePath: string) => boolean;
  includeFile?: (relativePath: string) => boolean;
  onLimit?: (reason: 'file_limit' | 'entry_limit') => void;
  onError?: (relativePath: string, error: unknown) => void;
}

/** Bounded directory iteration avoids allocating an entire large directory or following links. */
export async function discoverFiles(
  root: string,
  options: DiscoveryOptions = {},
): Promise<string[]> {
  const files: string[] = [];
  const pending = [{ directory: root, relativePath: '', depth: 0 }];
  let visited = 0;
  while (pending.length) {
    options.signal?.throwIfAborted();
    const current = pending.pop();
    if (!current) break;
    let directory: Dir;
    try {
      directory = await opendir(current.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (options.onError) {
        options.onError(current.relativePath, error);
        continue;
      }
      throw error;
    }
    for await (const entry of directory) {
      options.signal?.throwIfAborted();
      visited += 1;
      if (visited > (options.maxEntries ?? Number.POSITIVE_INFINITY)) {
        options.onLimit?.('entry_limit');
        return files.sort();
      }
      if (entry.isSymbolicLink()) continue;
      const path = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (current.depth >= (options.maxDepth ?? Number.POSITIVE_INFINITY)) continue;
        if (options.skipDirectory?.(path)) continue;
        pending.push({
          directory: join(current.directory, entry.name),
          relativePath: path,
          depth: current.depth + 1,
        });
      } else if (entry.isFile() && (!options.includeFile || options.includeFile(path))) {
        if (files.length >= (options.maxFiles ?? Number.POSITIVE_INFINITY)) {
          options.onLimit?.('file_limit');
          return files.sort();
        }
        files.push(path);
      }
    }
  }
  return files.sort();
}
