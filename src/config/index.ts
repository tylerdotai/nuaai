import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import { harnessConfig } from '../../.config/harness.config.js';

export { harnessConfig };

const providerSchema = z.object({
  name: z.string().default('ollama'),
  model: z.string().default('qwen3.5:latest'),
  baseUrl: z.string().url().default('http://127.0.0.1:11434'),
});

export const runtimeConfigSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().default('NUAI'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65_535).default(8787),
  workspaceRoot: z.string().default(process.cwd()),
  authSecret: z.string().min(32).optional(),
  provider: providerSchema.default({}),
  embedding: z
    .object({
      model: z.string().default('nomic-embed-text:latest'),
      baseUrl: z.string().url().default('http://127.0.0.1:11434'),
    })
    .default({}),
  limits: z
    .object({
      maxTurns: z.number().int().positive().max(100).default(12),
      maxToolCalls: z.number().int().positive().max(100).default(24),
      maxOutputBytes: z.number().int().positive().max(10_000_000).default(1_000_000),
      runTimeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
      providerTimeoutMs: z.number().int().positive().max(600_000).default(180_000),
      toolTimeoutMs: z.number().int().positive().max(120_000).default(30_000),
    })
    .default({}),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export function workspaceDirectory(root = process.cwd()): string {
  return resolve(root, harnessConfig.workspaceDir);
}
export function defaultRuntimeConfig(root = process.cwd()): RuntimeConfig {
  return runtimeConfigSchema.parse({ workspaceRoot: resolve(root) });
}
export function parseRuntimeConfig(value: unknown, root = process.cwd()): RuntimeConfig {
  const raw = value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {};
  raw.version = 1;
  const parsed = runtimeConfigSchema.parse({ ...raw, workspaceRoot: root });
  const rawProvider = raw.provider;
  const hasExplicitCodexModel =
    rawProvider &&
    typeof rawProvider === 'object' &&
    typeof (rawProvider as Record<string, unknown>).model === 'string' &&
    Boolean((rawProvider as Record<string, unknown>).model);
  if (parsed.provider.name === 'codex' && !hasExplicitCodexModel) parsed.provider.model = '';
  return parsed;
}
export async function loadRuntimeConfig(root = process.cwd()): Promise<RuntimeConfig> {
  const path = resolve(workspaceDirectory(root), 'config.json');
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return parseRuntimeConfig(value, root);
}
