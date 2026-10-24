import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openOutput } from '../src/ui/tui-outputs.js';

it('opens only explicit HTTP(S) URLs and absolute safe viewer paths, never other URI schemes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-open-'));
  const log = join(root, 'opened.txt');
  // A controlled executable records argv; no real browser, clipboard or desktop receives this test.
  await writeFile(join(root, 'xdg-open'), '#!/bin/sh\nprintf "%s" "$1" > "$NUAAI_OPEN_LOG"\n', {
    mode: 0o700,
  });
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
  vi.stubEnv('NUAAI_OPEN_LOG', log);
  try {
    await expect(openOutput('javascript:payload.txt')).rejects.toThrow('absolute');
    await expect(openOutput('file:///etc/passwd.txt')).rejects.toThrow('absolute');
    const path = join(root, 'spaces ; $(not-a-command).txt');
    await openOutput(path);
    expect(await readFile(log, 'utf8')).toBe(path);
    await openOutput('https://example.invalid/a');
    expect(await readFile(log, 'utf8')).toBe('https://example.invalid/a');
    await expect(openOutput(join(root, 'execute.desktop'))).rejects.toThrow('not opened');
  } finally {
    vi.unstubAllEnvs();
  }
});
