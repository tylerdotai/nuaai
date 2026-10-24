import { randomInt, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { MAX_GOAL_DURATION_MS, MAX_GOAL_RUNS } from '../core/execution-policy.js';

import { harnessConfig } from '../../.config/harness.config.js';

export { harnessConfig };

const providerSchema = z.object({
  name: z.string().default('ollama'),
  model: z.string().default('qwen3.5:latest'),
  selectedModels: z.record(z.string(), z.string().trim().min(1)).prefault({}),
  baseUrl: z.string().url().default('http://127.0.0.1:11434'),
  contextWindow: z.number().int().positive().max(262_144).default(262_144),
  codex: z
    .object({
      executable: z.string().min(1).default('codex'),
      timeoutMs: z.number().int().positive().max(900_000).default(900_000),
    })
    .prefault({}),
});

const searchSchema = z.object({
  searxngUrl: z.string().url().default('http://127.0.0.1:40102'),
  crawl4aiUrl: z.string().url().default('http://127.0.0.1:40103'),
  flaresolverrUrl: z.string().url().default('http://127.0.0.1:40104'),
  duckduckgoEnabled: z.boolean().default(true),
});

const webSchema = z.object({
  publicBasePath: z
    .string()
    .trim()
    .regex(/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?\/?$/)
    .transform((value) => (value === '/' ? value : value.replace(/\/+$/u, '')))
    .default('/'),
});

const matrixSchema = z.object({
  enabled: z.boolean().default(false),
  homeserverUrl: z.string().url().default('http://127.0.0.1:40105'),
  userId: z.string().min(1).optional(),
  roomId: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  pollTimeoutMs: z.number().int().positive().max(120_000).default(25_000),
  allowedUsers: z.array(z.string().min(1)).default([]),
  allowedRooms: z.array(z.string().min(1)).default([]),
  freeResponseRooms: z.array(z.string().min(1)).default([]),
  ignoreUserPatterns: z.array(z.string().min(1)).default([]),
  requireMention: z.boolean().default(false),
  processNotices: z.boolean().default(false),
  allowRoomMentions: z.boolean().default(false),
  autoThread: z.boolean().default(true),
  reactions: z.boolean().default(true),
  maxMessageLength: z.number().int().positive().max(65_535).default(16_000),
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

const permissionProfileSchema = z.enum(['read-only', 'operator']);

const mcpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).prefault({}),
  permission: z.enum(['read', 'write', 'execute']).default('read'),
});

const computerSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string().default('cua-driver'),
  args: z.array(z.string()).default(['mcp']),
});

const agentSchema = z.object({
  enabled: z.boolean().default(false),
  timeoutMs: z.number().int().positive().max(600_000).default(300_000),
  maxOutputBytes: z.number().int().positive().max(10_000_000).default(2_000_000),
  commands: z
    .record(
      z.string(),
      z.object({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        inheritEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
      }),
    )
    .prefault({}),
});

export const learningModeSchema = z.enum(['automatic', 'manual', 'off']);
export type LearningMode = z.infer<typeof learningModeSchema>;

export const runtimeConfigSchema = z.object({
  learning: z.object({ mode: learningModeSchema.default('automatic') }).prefault({}),
  version: z.literal(1).default(1),
  name: z.string().default('NUAAI'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65_535).default(40_101),
  workspaceRoot: z.string().default(process.cwd()),
  authSecret: z.string().min(32).optional(),
  provider: providerSchema.prefault({}),
  embedding: z
    .object({
      model: z.string().default('nomic-embed-text:latest'),
      baseUrl: z.string().url().default('http://127.0.0.1:11434'),
    })
    .prefault({}),
  search: searchSchema.prefault({}),
  web: webSchema.prefault({}),
  matrix: matrixSchema.prefault({}),
  audio: audioSchema.prefault({}),
  mcp: z
    .object({
      enabled: z.boolean().default(false),
      servers: z.record(z.string(), mcpServerSchema).prefault({}),
      computer: computerSchema.prefault({}),
    })
    .prefault({}),
  agents: agentSchema.prefault({}),
  features: featureSchema.prefault({}),
  permissions: z
    .object({
      web: permissionProfileSchema.default('operator'),
      matrix: permissionProfileSchema.default('operator'),
      scheduler: permissionProfileSchema.default('operator'),
    })
    .prefault({}),
  limits: z
    .object({
      maxTurns: z.number().int().positive().max(100).default(48),
      maxGoalSlices: z.number().int().positive().max(MAX_GOAL_RUNS).default(4),
      maxGoalFamilyRuns: z.number().int().positive().max(MAX_GOAL_RUNS).default(12),
      goalTimeoutMs: z.number().int().positive().max(MAX_GOAL_DURATION_MS).default(600_000),
      maxToolCalls: z.number().int().positive().max(100).default(48),
      maxToolCostUnits: z.number().int().positive().max(1_000).default(96),
      maxOutputBytes: z.number().int().positive().max(10_000_000).default(1_000_000),
      runTimeoutMs: z.number().int().positive().max(3_600_000).default(960_000),
      providerTimeoutMs: z.number().int().positive().max(600_000).default(600_000),
      toolTimeoutMs: z.number().int().positive().max(120_000).default(30_000),
      approvalTtlMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
      maxContextTokens: z.number().int().positive().max(1_000_000).default(262_144),
      contextResponseReserveTokens: z.number().int().nonnegative().max(262_144).default(8_192),
      maxContextSummaryTokens: z.number().int().positive().max(65_536).default(4_096),
      maxContextBytes: z.number().int().positive().max(2_000_000).default(1_000_000),
      maxMemoryContextBytes: z.number().int().positive().max(200_000).default(64_000),
      maxToolResultBytes: z.number().int().positive().max(200_000).default(16_000),
    })
    .prefault({}),
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
  const rawLimits =
    raw.limits && typeof raw.limits === 'object'
      ? { ...(raw.limits as Record<string, unknown>) }
      : {};
  if (
    rawLimits.maxContextTokens === undefined &&
    typeof rawLimits.maxContextBytes === 'number' &&
    Number.isFinite(rawLimits.maxContextBytes)
  )
    rawLimits.maxContextTokens = Math.max(1, Math.ceil(rawLimits.maxContextBytes / 3));
  raw.limits = rawLimits;
  const rawProvider =
    raw.provider && typeof raw.provider === 'object'
      ? { ...(raw.provider as Record<string, unknown>) }
      : {};
  const rawSelectedModels =
    rawProvider.selectedModels && typeof rawProvider.selectedModels === 'object'
      ? { ...(rawProvider.selectedModels as Record<string, unknown>) }
      : {};
  if (
    typeof rawProvider.name === 'string' &&
    typeof rawProvider.model === 'string' &&
    rawProvider.model.trim()
  )
    rawSelectedModels[rawProvider.name] = rawProvider.model;
  rawProvider.selectedModels = rawSelectedModels;
  raw.provider = rawProvider;
  const environmentPort = Number(process.env.NUAAI_PORT);
  if (Number.isInteger(environmentPort) && environmentPort >= 1 && environmentPort <= 65_535)
    raw.port = environmentPort;
  const environmentHost = process.env.NUAAI_HOST;
  if (environmentHost?.trim()) raw.host = environmentHost.trim();
  const rawWeb =
    raw.web && typeof raw.web === 'object' ? { ...(raw.web as Record<string, unknown>) } : {};
  if (rawWeb.publicBasePath === undefined && process.env.NUAAI_PUBLIC_BASE_PATH)
    rawWeb.publicBasePath = process.env.NUAAI_PUBLIC_BASE_PATH;
  raw.web = rawWeb;
  const rawMatrix =
    raw.matrix && typeof raw.matrix === 'object'
      ? { ...(raw.matrix as Record<string, unknown>) }
      : {};
  const matrixEnvironment = [
    ['homeserverUrl', 'NUAAI_MATRIX_HOMESERVER_URL'],
    ['userId', 'NUAAI_MATRIX_USER_ID'],
    ['roomId', 'NUAAI_MATRIX_ROOM_ID'],
    ['requireMention', 'NUAAI_MATRIX_REQUIRE_MENTION'],
    ['processNotices', 'NUAAI_MATRIX_PROCESS_NOTICES'],
    ['allowRoomMentions', 'NUAAI_MATRIX_ALLOW_ROOM_MENTIONS'],
    ['autoThread', 'NUAAI_MATRIX_AUTO_THREAD'],
    ['reactions', 'NUAAI_MATRIX_REACTIONS'],
  ] as const;
  for (const [key, environmentName] of matrixEnvironment) {
    if (rawMatrix[key] !== undefined || !process.env[environmentName]) continue;
    const value = process.env[environmentName] as string;
    rawMatrix[key] = ['true', '1', 'yes'].includes(value.toLowerCase())
      ? true
      : ['false', '0', 'no'].includes(value.toLowerCase())
        ? false
        : value;
  }
  const matrixLists = [
    ['allowedUsers', 'NUAAI_MATRIX_ALLOWED_USERS'],
    ['allowedRooms', 'NUAAI_MATRIX_ALLOWED_ROOMS'],
    ['freeResponseRooms', 'NUAAI_MATRIX_FREE_RESPONSE_ROOMS'],
    ['ignoreUserPatterns', 'NUAAI_MATRIX_IGNORE_USER_PATTERNS'],
  ] as const;
  for (const [key, environmentName] of matrixLists) {
    if (rawMatrix[key] !== undefined || !process.env[environmentName]) continue;
    rawMatrix[key] = process.env[environmentName]
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (process.env.NUAAI_MATRIX_MAX_MESSAGE_LENGTH && rawMatrix.maxMessageLength === undefined)
    rawMatrix.maxMessageLength = Number(process.env.NUAAI_MATRIX_MAX_MESSAGE_LENGTH);
  raw.matrix = rawMatrix;
  const parsed = runtimeConfigSchema.parse({ ...raw, workspaceRoot: root });
  if (
    parsed.matrix.enabled &&
    parsed.matrix.allowedUsers.length === 0 &&
    parsed.matrix.allowedRooms.length === 0
  )
    throw new Error('Matrix requires at least one allowed user or room');
  const hasExplicitCodexModel = typeof rawProvider.model === 'string' && Boolean(rawProvider.model);
  if (parsed.provider.name === 'codex' && !hasExplicitCodexModel) parsed.provider.model = '';
  if (parsed.provider.model && !parsed.provider.selectedModels[parsed.provider.name])
    parsed.provider.selectedModels[parsed.provider.name] = parsed.provider.model;
  parsed.provider.selectedModels.ollama ??= 'qwen3.5:latest';
  if (!parsed.matrix.accessToken && process.env.NUAAI_MATRIX_ACCESS_TOKEN)
    parsed.matrix.accessToken = process.env.NUAAI_MATRIX_ACCESS_TOKEN;
  return parsed;
}
export async function loadRuntimeConfig(root = process.cwd()): Promise<RuntimeConfig> {
  const directory = workspaceDirectory(root);
  loadDotenv({ path: resolve(directory, 'matrix.env'), override: false, quiet: true });
  const path = resolve(directory, 'config.json');
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return parseRuntimeConfig(value, root);
}

const configWrites = new Map<string, Promise<void>>();
async function updateRuntimeConfig(
  root: string,
  update: (raw: Record<string, unknown>) => void,
): Promise<void> {
  const path = resolve(workspaceDirectory(root), 'config.json');
  const apply = async () => {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Stored runtime configuration must be an object');
    update(raw as Record<string, unknown>);
    const staged = `${path}.${randomUUID()}.partial`;
    await writeFile(staged, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(staged, path);
  };
  // A rejected write is reported to its caller; it must not poison later independent settings writes.
  const previous = configWrites.get(path) ?? Promise.resolve();
  const pending = previous.then(apply, apply);
  configWrites.set(path, pending);
  try {
    await pending;
  } finally {
    if (configWrites.get(path) === pending) configWrites.delete(path);
  }
}

export async function persistProviderSelection(
  root: string,
  provider: string,
  model: string,
): Promise<void> {
  if (!provider.trim() || !model.trim()) throw new Error('Provider and model are required');
  await updateRuntimeConfig(root, (raw) => {
    const current =
      raw.provider && typeof raw.provider === 'object'
        ? (raw.provider as Record<string, unknown>)
        : {};
    const selectedModels =
      current.selectedModels && typeof current.selectedModels === 'object'
        ? { ...(current.selectedModels as Record<string, unknown>) }
        : {};
    selectedModels[provider] = model;
    raw.provider = { ...current, name: provider, model, selectedModels };
  });
}

export async function persistLearningMode(root: string, mode: LearningMode): Promise<void> {
  learningModeSchema.parse(mode);
  await updateRuntimeConfig(root, (raw) => {
    raw.learning = {
      ...(raw.learning && typeof raw.learning === 'object' ? raw.learning : {}),
      mode,
    };
  });
  const stored = JSON.parse(
    await readFile(resolve(workspaceDirectory(root), 'config.json'), 'utf8'),
  ) as RuntimeConfig;
  if (stored.learning.mode !== mode)
    throw new Error('Learning mode persistence could not be verified');
}
