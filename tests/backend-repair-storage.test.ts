import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';

const roots: string[] = [];
const stores: DatabaseStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('migrates private recovery storage, survives reopening, stays off RunRow, and cleans deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backend-recovery-'));
  roots.push(root);
  let store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  const { session } = store.createSession('Private recovery');
  const thread = store.createThread(session.id, 'Main');
  const run = store.createRun(thread.id, 'input', 'fixture', 'fixture', 'recovery-correlation');
  // Model the previous schema with an existing durable run but no recovery table.
  store.database.raw.exec('DROP TABLE run_execution_contexts');
  store.close();
  stores.pop();
  store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  expect(store.getRun(run.id)?.input).toBe('input');
  const value = {
    permissionSource: 'web',
    permissions: {
      approved: ['read', 'write'] as Array<'read' | 'write' | 'execute'>,
      capabilities: { filesystem: true },
    },
    images: [{ name: 'private.png', mimeType: 'image/png', data: 'private-image-data' }],
  };
  expect(store.getRunExecutionContext(run.id)).toBeUndefined();
  store.saveRunExecutionContext(run.id, value);
  expect(store.getRunExecutionContext(run.id)).toEqual(value);
  expect(JSON.stringify(store.getRun(run.id))).not.toContain('private-image-data');
  expect(store.listEvents()).toEqual([]);
  store.close();
  stores.pop();
  store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  expect(store.getRunExecutionContext(run.id)).toEqual(value);
  store.saveRunExecutionContext(run.id, { ...value, images: [] });
  expect(store.getRunExecutionContext(run.id)?.images).toEqual([]);
  expect(() => store.saveRunExecutionContext('missing', value)).toThrow();
  store.deleteThread(thread.id);
  expect(store.getRunExecutionContext(run.id)).toBeUndefined();
  const otherThread = store.createThread(session.id, 'Other');
  const otherRun = store.createRun(otherThread.id, 'input', 'fixture', 'fixture', 'other');
  store.saveRunExecutionContext(otherRun.id, value);
  store.deleteSession(session.id);
  expect(store.getRunExecutionContext(otherRun.id)).toBeUndefined();
});
