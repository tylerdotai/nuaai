import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { saveArtifact } from '../src/ui/tui-outputs.js';

it('downloads exact authenticated artifact bytes without overwriting files or leaking credentials to arbitrary routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-output-'));
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    expect(req.headers.authorization).toBe('Bearer fixture-token');
    if (req.url?.includes('redirect')) {
      res.writeHead(302, { location: 'https://example.invalid/' });
      res.end();
      return;
    }
    res.end(Buffer.from([0, 1, 2, 255]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const base = `http://127.0.0.1:${address.port}/mount`;
  const route = 'api/runs/run-1/artifacts/artifact-1/download';
  try {
    const path = await saveArtifact(base, 'fixture-token', route, '../../artifact.bin', root);
    expect(await readFile(path)).toEqual(Buffer.from([0, 1, 2, 255]));
    const destination = join(root, 'keep.txt');
    await writeFile(destination, 'keep existing');
    await expect(
      saveArtifact(base, 'fixture-token', route, 'x', root, destination),
    ).rejects.toThrow();
    expect(await readFile(destination, 'utf8')).toBe('keep existing');
    const before = hits.length;
    await expect(
      saveArtifact(base, 'fixture-token', 'https://example.invalid/stolen', 'x', root),
    ).rejects.toThrow('artifact URL');
    await expect(saveArtifact(base, 'fixture-token', 'api/status', 'x', root)).rejects.toThrow(
      'artifact URL',
    );
    expect(hits.length).toBe(before);
    await expect(
      saveArtifact(base, 'fixture-token', 'api/runs/run-1/artifacts/redirect/download', 'x', root),
    ).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
