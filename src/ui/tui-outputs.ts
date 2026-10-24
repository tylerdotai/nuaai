import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { localPath } from './tui-files.js';
import { type TuiConversationMessage, tuiArtifactLines } from './tui-state.js';

export function codeBlocks(content: string): string[] {
  const blocks: string[] = [];
  const lines = content.split('\n');
  let fence = '';
  let block: string[] = [];
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (!fence && marker) {
      fence = marker[1];
      block = [];
    } else if (
      fence &&
      marker &&
      marker[1][0] === fence[0] &&
      marker[1].length >= fence.length &&
      !marker[2].trim()
    ) {
      blocks.push(block.join('\n'));
      fence = '';
    } else if (fence) block.push(line);
  }
  return blocks;
}

export function clipboardSequence(text: string): string {
  if (Buffer.byteLength(text) > 100 * 1024)
    throw new Error('Clipboard text exceeds 100 KiB; export it instead.');
  return `\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`;
}

async function outputPath(root: string, name: string, destination?: string): Promise<string> {
  if (destination) return localPath(destination);
  const directory = resolve(root, '.nuaai/exports');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safeName =
    basename(name)
      .replace(/[^a-zA-Z0-9._-]/gu, '_')
      .slice(-120) || 'artifact.bin';
  return resolve(directory, `${randomUUID()}-${safeName}`);
}

export async function exportConversation(
  root: string,
  title: string,
  messages: TuiConversationMessage[],
  destination?: string,
): Promise<string> {
  const path = await outputPath(root, 'conversation.md', destination);
  const markdown = `# ${title.replaceAll('\n', ' ')}\n\n${messages.map((message) => `## ${message.role === 'user' ? 'You' : 'NUAAI'}\n\n${message.content}\n\n${tuiArtifactLines(message).join('\n')}`).join('\n\n')}\n`;
  await writeFile(path, markdown, { flag: 'wx', mode: 0o600 });
  return path;
}

export async function saveArtifact(
  baseUrl: string,
  token: string,
  url: string,
  title: string,
  root: string,
  destination?: string,
): Promise<string> {
  const base = new URL(`${baseUrl.replace(/\/$/u, '')}/`);
  const target = new URL(url, base);
  const relative = target.pathname.slice(base.pathname.length);
  if (
    target.origin !== base.origin ||
    !target.pathname.startsWith(base.pathname) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !/^api\/runs\/[^/]+\/artifacts\/[^/]+\/download$/u.test(relative)
  )
    throw new Error(
      "Invalid artifact URL; only this daemon's authenticated artifact download routes are allowed.",
    );
  const response = await fetch(target, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Artifact download failed: ${response.status}`);
  const maximum = 32 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body.cancel();
    throw new Error('Artifact exceeds the 32 MiB terminal save limit.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error('Artifact exceeds the 32 MiB terminal save limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const path = await outputPath(root, title, destination);
  await writeFile(path, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
  return path;
}

export async function openOutput(target: string): Promise<void> {
  if (/^https?:\/\//u.test(target)) {
    const url = new URL(target);
    if (url.username || url.password) throw new Error('Refusing a URL containing credentials.');
  } else if (!isAbsolute(target)) {
    throw new Error('Only HTTP(S) URLs or absolute saved-file paths may be opened.');
  } else if (
    ![
      '.txt',
      '.md',
      '.csv',
      '.json',
      '.pdf',
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.gif',
      '.mp3',
      '.wav',
      '.mp4',
      '.webm',
    ].includes(extname(target).toLowerCase())
  ) {
    throw new Error(
      'Saved the artifact, but this file type is not opened automatically. Open it manually if trusted.',
    );
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  await promisify(execFile)(command, [target], { timeout: 10_000, maxBuffer: 64 * 1024 });
}
