import { load as loadSqliteVec } from 'sqlite-vec';

import type { MemoryDatabase } from './db.js';

export interface VectorRecord<T> {
  id: string;
  vector: number[];
  value: T;
}

export interface VectorMatch<T> extends VectorRecord<T> {
  score: number;
}

export function loadVectorExtension(db: MemoryDatabase): void {
  loadSqliteVec(db);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error('Vector dimensions must match');
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function searchVectors<T>(
  query: number[],
  records: VectorRecord<T>[],
  limit = 5,
): VectorMatch<T>[] {
  if (limit <= 0) {
    return [];
  }

  return records
    .map((record) => ({ ...record, score: cosineSimilarity(query, record.vector) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
