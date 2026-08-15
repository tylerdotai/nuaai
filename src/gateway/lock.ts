import { randomUUID } from 'node:crypto';
import { access, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import { workspaceDirectory } from '../config/index.js';

interface LockRecord {
  pid: number;
  owner: string;
  startedAt: number;
}

export interface DaemonLock {
  path: string;
  release(): Promise<void>;
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LockRecord>;
    if (
      typeof value.pid !== 'number' ||
      typeof value.owner !== 'string' ||
      typeof value.startedAt !== 'number'
    )
      return null;
    return value as LockRecord;
  } catch {
    return null;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Another process may have reclaimed the stale lock first.
  }
}

export async function acquireDaemonLock(root = process.cwd()): Promise<DaemonLock> {
  const path = resolve(workspaceDirectory(root), 'daemon.lock');
  const owner = randomUUID();
  const record: LockRecord = { pid: process.pid, owner, startedAt: Date.now() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path,
        release: async () => {
          if (released) return;
          released = true;
          const current = await readLock(path);
          if (current?.owner === owner) await unlinkIfPresent(path);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await readLock(path);
      if (current && (await processIsAlive(current.pid)))
        throw new Error(`Daemon already running (pid ${current.pid})`);
      await unlinkIfPresent(path);
    }
  }

  throw new Error('Unable to acquire daemon lock');
}

export async function daemonLockExists(root = process.cwd()): Promise<boolean> {
  try {
    await access(resolve(workspaceDirectory(root), 'daemon.lock'));
    return true;
  } catch {
    return false;
  }
}
