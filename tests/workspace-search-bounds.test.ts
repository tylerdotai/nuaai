import { mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { searchWorkspace } from '../src/workspace/fs.js';

it('finds later text matches while skipping a sparse oversized file and binary bytes before whole-file allocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-bounded-search-'));
  await writeFile(join(root, 'a-first.txt'), 'needle first\n');
  await writeFile(join(root, 'b-binary.dat'), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  const giant = await open(join(root, 'c-large.bin'), 'wx');
  try {
    await giant.truncate(3_000_000_001);
  } finally {
    await giant.close();
  }
  await writeFile(join(root, 'z-last.txt'), 'unrelated\nneedle last\n');
  const result = await searchWorkspace(root, 'needle');
  expect(result.matches).toEqual([
    { file: 'a-first.txt', line: 1, text: 'needle first' },
    { file: 'z-last.txt', line: 2, text: 'needle last' },
  ]);
  expect(result.skipped).toMatchObject({ oversized: 1, binary: 1 });
  expect(result.complete).toBe(false);
  expect(result.bytesRead).toBeLessThan(1024);
});

it('bounds matching, bytes and traversal with truthful partial-result diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-search-budget-'));
  for (let index = 0; index < 10; index += 1)
    await writeFile(join(root, `${index}.txt`), 'needle data\n');
  const matches = await searchWorkspace(root, 'needle', { limit: 2 });
  expect(matches.matches).toHaveLength(2);
  expect(matches.stoppedBecause).toBe('match_limit');
  const bytes = await searchWorkspace(root, 'needle', { maxBytes: 20 });
  expect(bytes.bytesRead).toBeLessThanOrEqual(20);
  expect(bytes.stoppedBecause).toBe('byte_limit');
  const files = await searchWorkspace(root, 'needle', { maxFiles: 2 });
  expect(files.scannedFiles).toBeLessThanOrEqual(2);
  expect(files.stoppedBecause).toBe('file_limit');
  const entries = await searchWorkspace(root, 'needle', { maxEntries: 2 });
  expect(entries.stoppedBecause).toBe('entry_limit');
});

it('rejects protected scopes and cancellation instead of returning a misleading empty search', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-search-scope-'));
  const controller = new AbortController();
  controller.abort(new Error('search cancelled'));
  await expect(searchWorkspace(root, 'needle', { signal: controller.signal })).rejects.toThrow(
    'search cancelled',
  );
  await expect(searchWorkspace(root, 'needle', { path: '.ssh' })).rejects.toThrow('Protected');
});
