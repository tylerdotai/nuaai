import { randomInt } from 'node:crypto';
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

const searchSchema = z.object({
  searxngUrl: z.string().url().default('http://127.0.0.1:40102'),
  crawl4aiUrl: z.string().url().default('http://127.0.0.1:40103'),
  flaresolverrUrl: z.string().url().default('http://127.0.0.1:40104'),
  duckduckgoEnabled: z.boolean().default(true),
});

const matrixSchema = z.object({
  enabled: z.boolean().default(false),
  homeserverUrl: z.string().url().default('http://127.0.0.1:40105'),
  userId: z.string().min(1).optional(),
  roomId: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  pollTimeoutMs: z.number().int().positive().max(120_000).default(25_000),
});

const audioSchema = z.object({
  voiceEnabled: z.boolean().default(false),
  ttsEnabled: z.boolean().default(false),
  pythonCommand: z.string().default('python3'),
  scriptPath: z.string().default('scripts/voice-bridge.py'),
  outputDirectory: z.string().default('.nuaai/audio'),
  model: z.string().default('small'),
  device: z.string().default('cpu'),
  computeType: z.string().default('int8'),
  voice: z.string().default('af_sarah'),
  kokoroModelPath: z.string().default(''),
  kokoroVoicesPath: z.string().default(''),
  timeoutMs: z.number().int().positive().max(600_000).default(180_000),
});

const featureSchema = z.object({
  ollama: z.boolean().default(true),
  codex: z.boolean().default(true),
  matrix: z.boolean().default(false),
  search: z.boolean().default(true),
  browser: z.boolean().default(true),
  telemetry: z.literal(false).default(false),
});

const mcpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  permission: z.enum(['read', 'write', 'execute']).default('read'),
});

const computerSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string().default('cua-driver'),
  args: z.array(z.string()).default(['mcp']),
});

export const runtimeConfigSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().default('NUAAI'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65_535).default(40_101),
  workspaceRoot: z.string().default(process.cwd()),
  authSecret: z.string().min(32).optional(),
  provider: providerSchema.default({}),
  embedding: z
    .object({
      model: z.string().default('nomic-embed-text:latest'),
      baseUrl: z.string().url().default('http://127.0.0.1:11434'),
    })
    .default({}),
  search: searchSchema.default({}),
  matrix: matrixSchema.default({}),
  audio: audioSchema.default({}),
  mcp: z
    .object({
      enabled: z.boolean().default(false),
      servers: z.record(mcpServerSchema).default({}),
      computer: computerSchema.default({}),
    })
    .default({}),
  features: featureSchema.default({}),
  limits: z
    .object({
      maxTurns: z.number().int().positive().max(100).default(12),
      maxToolCalls: z.number().int().positive().max(100).default(24),
      maxOutputBytes: z.number().int().positive().max(10_000_000).default(1_000_000),
      runTimeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
      providerTimeoutMs: z.number().int().positive().max(600_000).default(180_000),
      toolTimeoutMs: z.number().int().positive().max(120_000).default(30_000),
      maxContextBytes: z.number().int().positive().max(2_000_000).default(120_000),
    })
    .default({}),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

function randomLocalPort(used: Set<number>): number {
  let port = randomInt(40_000, 60_000);
  while (used.has(port)) port = randomInt(40_000, 60_000);
  used.add(port);
  return port;
}

export function workspaceDirectory(root = process.cwd()): string {
  return resolve(root, harnessConfig.workspaceDir);
}
export function defaultRuntimeConfig(root = process.cwd()): RuntimeConfig {
  const used = new Set<number>();
  const daemonPort = randomLocalPort(used);
  const synapsePort = randomLocalPort(used);
  const searxngPort = randomLocalPort(used);
  const crawl4aiPort = randomLocalPort(used);
  const flaresolverrPort = randomLocalPort(used);
  return runtimeConfigSchema.parse({
    workspaceRoot: resolve(root),
    port: daemonPort,
    search: {
      searxngUrl: `http://127.0.0.1:${searxngPort}`,
      crawl4aiUrl: `http://127.0.0.1:${crawl4aiPort}`,
      flaresolverrUrl: `http://127.0.0.1:${flaresolverrPort}`,
    },
    matrix: { homeserverUrl: `http://127.0.0.1:${synapsePort}` },
  });
}
export function parseRuntimeConfig(value: unknown, root = process.cwd()): RuntimeConfig {
  const raw = value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {};
  raw.version = 1;
  const environmentPort = Number(process.env.NUAAI_PORT);
  if (Number.isInteger(environmentPort) && environmentPort >= 1 && environmentPort <= 65_535)
    raw.port = environmentPort;
  const parsed = runtimeConfigSchema.parse({ ...raw, workspaceRoot: root });
  const rawProvider = raw.provider;
  const hasExplicitCodexModel =
    rawProvider &&
    typeof rawProvider === 'object' &&
    typeof (rawProvider as Record<string, unknown>).model === 'string' &&
    Boolean((rawProvider as Record<string, unknown>).model);
  if (parsed.provider.name === 'codex' && !hasExplicitCodexModel) parsed.provider.model = '';
  if (!parsed.matrix.accessToken && process.env.NUAAI_MATRIX_ACCESS_TOKEN)
    parsed.matrix.accessToken = process.env.NUAAI_MATRIX_ACCESS_TOKEN;
  return parsed;
}
export async function loadRuntimeConfig(root = process.cwd()): Promise<RuntimeConfig> {
  const path = resolve(workspaceDirectory(root), 'config.json');
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return parseRuntimeConfig(value, root);
}
