import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { execa } from 'execa';

import { assertSafeExistingPath } from '../workspace/fs.js';

const MAX_TEXT_CHARS = 40_000;
const MAX_INPUT_BYTES = 100_000_000;
const MAX_FRAME_COUNT = 8;
const MAX_FRAME_BYTES = 10_000_000;

export interface MediaProcessorConfig {
  allowedRoot: string;
  artifactDirectory: string;
  timeoutMs?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  pdftotextPath?: string;
  unzipPath?: string;
}

export interface MediaFrame {
  path: string;
  mimeType: 'image/jpeg';
  size: number;
}

export interface MediaInspection {
  path: string;
  kind: 'text' | 'image' | 'audio' | 'video' | 'document' | 'binary';
  mimeType: string;
  size: number;
  text?: string;
  metadata?: Record<string, unknown>;
  frames?: MediaFrame[];
  audioPath?: string;
  warnings?: string[];
}

const mimeTypes: Record<string, string> = {
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.md': 'text/markdown',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
};

const textExtensions = new Set([
  '.c',
  '.cfg',
  '.css',
  '.csv',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

function withinRoot(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  );
}

function decodeXml(value: string): string {
  return value
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function clip(value: string): string {
  return value.trim().slice(0, MAX_TEXT_CHARS);
}

export class MediaProcessor {
  private readonly root: string;
  private readonly artifactDirectory: string;
  private readonly timeoutMs: number;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly pdftotextPath: string;
  private readonly unzipPath: string;

  constructor(config: MediaProcessorConfig) {
    this.root = resolve(config.allowedRoot);
    this.artifactDirectory = resolve(config.artifactDirectory);
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.ffmpegPath = config.ffmpegPath ?? 'ffmpeg';
    this.ffprobePath = config.ffprobePath ?? 'ffprobe';
    this.pdftotextPath = config.pdftotextPath ?? 'pdftotext';
    this.unzipPath = config.unzipPath ?? 'unzip';
    if (!withinRoot(this.root, this.artifactDirectory))
      throw new Error('Media artifact directory escapes the allowed root');
  }

  async inspect(
    inputPath: string,
    options: { extractAudio?: boolean; extractFrames?: boolean } = {},
  ): Promise<MediaInspection> {
    const path = await assertSafeExistingPath(this.root, inputPath);
    const file = await stat(path);
    if (!file.isFile()) throw new Error(`Media input is not a regular file: ${inputPath}`);
    if (file.size > MAX_INPUT_BYTES) throw new Error('Media input exceeds the 100 MB limit');
    const extension = extname(path).toLowerCase();
    const mimeType = mimeTypes[extension] ?? 'application/octet-stream';
    const base = { path: relative(this.root, path), mimeType, size: file.size };

    if (textExtensions.has(extension))
      return { ...base, kind: 'text', text: clip(await readFile(path, 'utf8')) };
    if (extension === '.pdf')
      return {
        ...base,
        kind: 'document',
        text: clip(await this.textCommand(this.pdftotextPath, [path, '-'])),
      };
    if (extension === '.docx')
      return {
        ...base,
        kind: 'document',
        text: clip(await this.officeXml(path, ['word/document.xml'])),
      };
    if (extension === '.xlsx')
      return {
        ...base,
        kind: 'document',
        text: clip(
          [
            await this.officeXml(path, ['xl/sharedStrings.xml']),
            await this.officeXml(path, ['xl/worksheets/sheet1.xml']),
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      };
    if (mimeType.startsWith('image/')) return { ...base, kind: 'image' };
    if (mimeType.startsWith('audio/'))
      return { ...base, kind: 'audio', metadata: await this.probe(path) };
    if (mimeType.startsWith('video/')) {
      const warnings: string[] = [];
      const result: MediaInspection = {
        ...base,
        kind: 'video',
        metadata: await this.probe(path),
        warnings,
      };
      if (options.extractFrames) {
        try {
          result.frames = await this.extractFrames(path);
        } catch (error) {
          warnings.push(
            `Frame extraction failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (options.extractAudio) {
        try {
          result.audioPath = await this.extractAudio(path);
        } catch (error) {
          warnings.push(
            `Audio extraction failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!warnings.length) result.warnings = undefined;
      return result;
    }
    return { ...base, kind: 'binary' };
  }

  private async probe(path: string): Promise<Record<string, unknown>> {
    const result = await execa(
      this.ffprobePath,
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
      { cwd: this.root, timeout: this.timeoutMs, reject: false, maxBuffer: 1_000_000 },
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || `ffprobe exited ${result.exitCode}`);
    const parsed = JSON.parse(result.stdout) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  }

  private async textCommand(command: string, args: string[]): Promise<string> {
    const result = await execa(command, args, {
      cwd: this.root,
      timeout: this.timeoutMs,
      reject: false,
      maxBuffer: 2_000_000,
    });
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || `${command} exited ${result.exitCode}`);
    return result.stdout;
  }

  private async officeXml(path: string, members: string[]): Promise<string> {
    const result = await execa(this.unzipPath, ['-p', path, ...members], {
      cwd: this.root,
      timeout: this.timeoutMs,
      reject: false,
      maxBuffer: 2_000_000,
    });
    if (result.exitCode !== 0) return '';
    return decodeXml(result.stdout);
  }

  private async extractFrames(path: string): Promise<MediaFrame[]> {
    const directory = resolve(this.artifactDirectory, `frames-${randomUUID()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const pattern = resolve(directory, 'frame-%02d.jpg');
    const result = await execa(
      this.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        path,
        '-vf',
        'fps=1,scale=1280:1280:force_original_aspect_ratio=decrease',
        '-frames:v',
        String(MAX_FRAME_COUNT),
        '-q:v',
        '4',
        '-y',
        pattern,
      ],
      { cwd: this.root, timeout: this.timeoutMs, reject: false, maxBuffer: 100_000 },
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || `ffmpeg exited ${result.exitCode}`);
    const names = (await readdir(directory)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
    const frames: MediaFrame[] = [];
    for (const name of names.slice(0, MAX_FRAME_COUNT)) {
      const framePath = resolve(directory, name);
      const size = (await stat(framePath)).size;
      if (size > MAX_FRAME_BYTES) continue;
      frames.push({ path: framePath, mimeType: 'image/jpeg', size });
    }
    return frames;
  }

  private async extractAudio(path: string): Promise<string> {
    const directory = resolve(this.artifactDirectory, `audio-${randomUUID()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const outputPath = resolve(directory, 'audio.wav');
    const result = await execa(
      this.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        path,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-y',
        outputPath,
      ],
      { cwd: this.root, timeout: this.timeoutMs, reject: false, maxBuffer: 100_000 },
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || `ffmpeg exited ${result.exitCode}`);
    const output = await stat(outputPath).catch(() => undefined);
    if (!output?.isFile() || output.size === 0)
      throw new Error('ffmpeg produced no audio artifact');
    return outputPath;
  }
}
