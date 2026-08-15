import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { workspaceDirectory } from '../config/index.js';

export type MemoryDatabase = Database.Database;

export interface MemoryRow {
  id: number;
  content: string;
  createdAt: number;
}

export function openMemoryDatabase(root = process.cwd()): MemoryDatabase {
  const directory = workspaceDirectory(root);
  mkdirSync(directory, { recursive: true });
  const db = new Database(join(directory, 'memory.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function addMemory(db: MemoryDatabase, content: string, createdAt = Date.now()): number {
  if (!content.trim()) {
    throw new Error('Memory content is required');
  }

  const result = db
    .prepare('INSERT INTO memories (content, created_at) VALUES (?, ?)')
    .run(content, createdAt);
  return Number(result.lastInsertRowid);
}

export function listMemories(db: MemoryDatabase): MemoryRow[] {
  return db
    .prepare('SELECT id, content, created_at AS createdAt FROM memories ORDER BY id ASC')
    .all() as MemoryRow[];
}
