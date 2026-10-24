import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import { decodeInputAttachments } from '../integrations/input-attachments.js';
import { type InputAttachment, attachmentAccept, attachmentMaxBytes } from '../web/attachments.js';
import type { PickerItem } from './tui-picker.js';

export function localPath(path: string): string {
  const unquoted = path.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2');
  return resolve(
    unquoted.startsWith('~/') ? resolve(homedir(), unquoted.slice(2)) : unquoted || '.',
  );
}

export async function attachmentPaths(query: string): Promise<PickerItem[]> {
  const path = localPath(query);
  let directory = dirname(path);
  let prefix = basename(path);
  try {
    if ((await stat(path)).isDirectory()) {
      directory = path;
      prefix = '';
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .filter(
      (entry) =>
        entry.isDirectory() ||
        attachmentAccept
          .split(',')
          .some((extension) => entry.name.toLowerCase().endsWith(extension)),
    )
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    )
    .map((entry) => ({
      id: `${entry.isDirectory() ? 'attach-dir' : 'attach-file'}:${resolve(directory, entry.name)}`,
      label: entry.name + (entry.isDirectory() ? sep : ''),
      detail: resolve(directory, entry.name),
    }));
}

export async function readAttachment(
  path: string,
  existing: InputAttachment[],
): Promise<InputAttachment> {
  const handle = await open(localPath(path), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Attach a regular file, not a directory or device.');
    if (info.size > attachmentMaxBytes) throw new Error('Attachments must total 512 KiB or less.');
    const buffer = Buffer.alloc(attachmentMaxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const attachment = {
      name: basename(localPath(path)),
      data: buffer.subarray(0, length).toString('base64'),
    };
    decodeInputAttachments([...existing, attachment]);
    return attachment;
  } finally {
    await handle.close();
  }
}
