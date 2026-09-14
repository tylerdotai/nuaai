import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { MediaProcessor } from '../src/integrations/media.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeFixtureRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'nuaai-media-'));
  temporaryRoots.push(root);
  await mkdir(resolve(root, '.nuaai/media'), { recursive: true });
  return root;
}

describe('bounded local media processing', () => {
  it('refuses protected runtime files and symlinks that escape the project root', async () => {
    const root = await makeFixtureRoot();
    const outside = await mkdtemp(resolve(tmpdir(), 'nuaai-media-outside-'));
    temporaryRoots.push(outside);
    await writeFile(resolve(root, '.nuaai/runtime.json'), '{"token":"do-not-read"}');
    await writeFile(resolve(outside, 'outside.txt'), 'outside');
    await symlink(resolve(outside, 'outside.txt'), resolve(root, 'outside-alias.txt'));
    const media = new MediaProcessor({
      allowedRoot: root,
      artifactDirectory: resolve(root, '.nuaai/media'),
    });

    await expect(media.inspect('.nuaai/runtime.json')).rejects.toThrow('Protected workspace file');
    await expect(media.inspect('outside-alias.txt')).rejects.toThrow('escapes workspace');
  });

  it('does not expose the ambient environment to media subprocesses', async () => {
    const root = await makeFixtureRoot();
    const input = resolve(root, 'sample.wav');
    const probe = resolve(root, 'probe.sh');
    await writeFile(input, 'audio');
    await writeFile(
      probe,
      '#!/bin/sh\nif [ -n "$NUAAI_MEDIA_SENTINEL" ]; then printf \'{"leaked":true}\'; else printf \'{"clean":true}\'; fi\n',
    );
    await chmod(probe, 0o700);
    const previous = process.env.NUAAI_MEDIA_SENTINEL;
    process.env.NUAAI_MEDIA_SENTINEL = 'must-not-leak';
    try {
      const media = new MediaProcessor({
        allowedRoot: root,
        artifactDirectory: resolve(root, '.nuaai/media'),
        ffprobePath: probe,
      });
      await expect(media.inspect(input)).resolves.toMatchObject({ metadata: { clean: true } });
    } finally {
      process.env.NUAAI_MEDIA_SENTINEL = previous;
    }
  });

  it('extracts ordinary text, DOCX XML, and XLSX worksheet content', async () => {
    const root = await makeFixtureRoot();
    await writeFile(resolve(root, 'notes.txt'), 'local-first text');
    const docxRoot = resolve(root, 'docx');
    await mkdir(resolve(docxRoot, 'word'), { recursive: true });
    await writeFile(
      resolve(docxRoot, 'word/document.xml'),
      '<w:document><w:body><w:p><w:r><w:t>DOCX local content</w:t></w:r></w:p></w:body></w:document>',
    );
    await execa('zip', ['-qr', resolve(root, 'sample.docx'), '.'], { cwd: docxRoot });
    const xlsxRoot = resolve(root, 'xlsx');
    await mkdir(resolve(xlsxRoot, 'xl/worksheets'), { recursive: true });
    await writeFile(
      resolve(xlsxRoot, 'xl/sharedStrings.xml'),
      '<sst><si><t>XLSX shared content</t></si></sst>',
    );
    await writeFile(
      resolve(xlsxRoot, 'xl/worksheets/sheet1.xml'),
      '<worksheet><sheetData><row><c><v>42</v></c></row></sheetData></worksheet>',
    );
    await execa('zip', ['-qr', resolve(root, 'sample.xlsx'), '.'], { cwd: xlsxRoot });

    const media = new MediaProcessor({
      allowedRoot: root,
      artifactDirectory: resolve(root, '.nuaai/media'),
    });
    await expect(media.inspect('notes.txt')).resolves.toMatchObject({
      kind: 'text',
      text: 'local-first text',
    });
    await expect(media.inspect('sample.docx')).resolves.toMatchObject({
      kind: 'document',
      text: expect.stringContaining('DOCX local content'),
    });
    await expect(media.inspect('sample.xlsx')).resolves.toMatchObject({
      kind: 'document',
      text: expect.stringContaining('XLSX shared content'),
    });
  });

  it('extracts bounded audio and frames from a local video without network access', async () => {
    const root = await makeFixtureRoot();
    const videoPath = resolve(root, 'sample.mp4');
    await execa(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=320x240:d=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-y',
        videoPath,
      ],
      { cwd: root },
    );
    const media = new MediaProcessor({
      allowedRoot: root,
      artifactDirectory: resolve(root, '.nuaai/media'),
      timeoutMs: 30_000,
    });
    const result = await media.inspect('sample.mp4', { extractAudio: true, extractFrames: true });
    expect(result).toMatchObject({ kind: 'video', mimeType: 'video/mp4' });
    expect(result.frames?.length).toBeGreaterThan(0);
    expect(result.frames?.length).toBeLessThanOrEqual(8);
    expect(result.audioPath).toBeTruthy();
    const audio = await readFile(result.audioPath as string);
    expect(audio.subarray(0, 4).toString()).toBe('RIFF');
    expect(result.frames?.every((frame) => frame.size <= 10_000_000)).toBe(true);
  });

  it('reports document, frame, audio, and artifact failures without hiding them', async () => {
    const root = await makeFixtureRoot();
    await writeFile(resolve(root, 'broken.pdf'), 'not a real PDF');
    await writeFile(resolve(root, 'broken.mp4'), 'not a real video');
    await writeFile(resolve(root, 'image.png'), 'not an actual image');
    await writeFile(resolve(root, 'audio.wav'), 'not an actual audio file');
    await writeFile(resolve(root, 'unknown.bin'), 'binary');
    const probe = resolve(root, 'probe.sh');
    const noArtifact = resolve(root, 'no-artifact.sh');
    await writeFile(probe, "#!/bin/sh\nprintf '{}'\n");
    await writeFile(noArtifact, '#!/bin/sh\nexit 0\n');
    await chmod(probe, 0o700);
    await chmod(noArtifact, 0o700);

    const imageMedia = new MediaProcessor({
      allowedRoot: root,
      artifactDirectory: resolve(root, '.nuaai/media'),
    });
    await expect(imageMedia.inspect('image.png')).resolves.toMatchObject({ kind: 'image' });
    await expect(imageMedia.inspect('unknown.bin')).resolves.toMatchObject({ kind: 'binary' });
    const audioMedia = new MediaProcessor({
      allowedRoot: root,
      artifactDirectory: resolve(root, '.nuaai/media'),
      ffprobePath: probe,
    });
    await expect(audioMedia.inspect('audio.wav')).resolves.toMatchObject({
      kind: 'audio',
      metadata: {},
    });
    const unavailableProbe = new MediaProcessor({
      allowedRoot: root,
      artifactDirectory: resolve(root, '.nuaai/media'),
      ffprobePath: '/bin/false',
    });
    await expect(unavailableProbe.inspect('audio.wav')).rejects.toThrow('ffprobe exited 1');

    const documentMedia = new MediaProcessor({
      allowedRoot: root,
      artifactDirectory: resolve(root, '.nuaai/media'),
      pdftotextPath: '/bin/false',
    });
    await expect(documentMedia.inspect('broken.pdf')).rejects.toThrow('/bin/false exited 1');

    const failingMedia = new MediaProcessor({
      allowedRoot: root,
      artifactDirectory: resolve(root, '.nuaai/media'),
      ffprobePath: probe,
      ffmpegPath: '/bin/false',
    });
    const failed = await failingMedia.inspect('broken.mp4', {
      extractAudio: true,
      extractFrames: true,
    });
    expect(failed.warnings).toEqual([
      'Frame extraction failed: ffmpeg exited 1',
      'Audio extraction failed: ffmpeg exited 1',
    ]);
    expect(failed.frames).toBeUndefined();
    expect(failed.audioPath).toBeUndefined();

    const artifactMedia = new MediaProcessor({
      allowedRoot: root,
      artifactDirectory: resolve(root, '.nuaai/media'),
      ffprobePath: probe,
      ffmpegPath: noArtifact,
    });
    const missingArtifact = await artifactMedia.inspect('broken.mp4', { extractAudio: true });
    expect(missingArtifact.warnings).toEqual([
      'Audio extraction failed: ffmpeg produced no audio artifact',
    ]);
  });

  it('rejects paths outside the allowed workspace', async () => {
    const root = await makeFixtureRoot();
    const media = new MediaProcessor({
      allowedRoot: root,
      artifactDirectory: resolve(root, '.nuaai/media'),
    });
    await expect(media.inspect('../outside.txt')).rejects.toThrow('Path escapes workspace');
  });
});
