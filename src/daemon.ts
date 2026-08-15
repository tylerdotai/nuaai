import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntimeConfig } from './config/index.js';
import { AgentRuntime } from './core/runtime.js';
import { Scheduler } from './core/scheduler.js';
import { acquireDaemonLock } from './gateway/lock.js';
import { ensureRuntimeIdentity } from './gateway/runtime.js';
import { MatrixBridge } from './integrations/matrix.js';
import {
  Crawl4AiClient,
  FlareSolverrClient,
  SearchStack,
  SearxngSearchClient,
} from './integrations/search.js';
import { DatabaseStore, openAppDatabase } from './memory/db.js';
import { PluginRegistry } from './plugins/registry.js';
import { ProviderRegistry } from './providers/registry.js';
import { SecretsManager } from './security/secrets.js';
import { type GatewayHandle, startServer } from './server.js';
import { loadFilesystemSkills } from './skills/loader.js';
import { SkillRegistry } from './skills/registry.js';
import { ToolRegistry } from './tools/registry.js';
import { initWorkspace } from './workspace/fs.js';

export interface DaemonHandle {
  gateway: GatewayHandle;
  runtime: AgentRuntime;
  scheduler: Scheduler;
  store: DatabaseStore;
  token: string;
  matrix?: MatrixBridge;
  stop(): Promise<void>;
}

export async function startDaemon(root = process.cwd()): Promise<DaemonHandle> {
  const resolvedRoot = resolve(root);
  await initWorkspace(resolvedRoot);
  const config = await loadRuntimeConfig(resolvedRoot);
  const effectiveConfig =
    process.env.NUAAI_TEST_MODE === '1'
      ? {
          ...config,
          provider: { ...config.provider, name: 'deterministic', model: 'deterministic' },
        }
      : config;
  const identity = ensureRuntimeIdentity(resolvedRoot);
  const store = new DatabaseStore(openAppDatabase(resolvedRoot));
  const secrets = new SecretsManager(store, resolvedRoot);
  const providers = new ProviderRegistry({
    root: resolvedRoot,
    providerName: effectiveConfig.provider.name,
    model: effectiveConfig.provider.model,
    baseUrl: effectiveConfig.provider.baseUrl,
    embeddingModel: effectiveConfig.embedding.model,
    timeoutMs: effectiveConfig.limits.providerTimeoutMs,
    ollamaEnabled: effectiveConfig.features.ollama,
    codexEnabled: effectiveConfig.features.codex,
  });
  const search = effectiveConfig.features.search
    ? new SearchStack({
        searxng: new SearxngSearchClient(effectiveConfig.search.searxngUrl),
        crawl4ai: new Crawl4AiClient(effectiveConfig.search.crawl4aiUrl),
        browser: effectiveConfig.features.browser ? undefined : null,
        flaresolverr: effectiveConfig.features.browser
          ? new FlareSolverrClient(effectiveConfig.search.flaresolverrUrl)
          : null,
      })
    : undefined;
  const tools = new ToolRegistry(resolvedRoot, search, {
    browserEnabled: effectiveConfig.features.browser,
  });
  const skills = new SkillRegistry();
  skills.register({
    name: 'workspace-status',
    description: 'Return the current NUAAI workspace root',
    version: '1.0.0',
    source: 'built-in',
    input: (await import('zod')).z.object({}),
    execute: async () => ({ root: resolvedRoot }),
  });
  await loadFilesystemSkills(resolvedRoot, skills, store);
  const plugins = new PluginRegistry(resolvedRoot, store);
  await plugins.load();
  const runtime = new AgentRuntime({
    root: resolvedRoot,
    config: effectiveConfig,
    store,
    providers,
    tools,
  });
  const matrix =
    effectiveConfig.features.matrix &&
    effectiveConfig.matrix.enabled &&
    effectiveConfig.matrix.accessToken &&
    effectiveConfig.matrix.userId
      ? new MatrixBridge({
          homeserverUrl: effectiveConfig.matrix.homeserverUrl,
          accessToken: effectiveConfig.matrix.accessToken,
          userId: effectiveConfig.matrix.userId,
          pollTimeoutMs: effectiveConfig.matrix.pollTimeoutMs,
        })
      : undefined;
  const scheduledRuns = new Map<string, string>();
  const scheduler = new Scheduler(
    store,
    (type, payload, context) => runtime.publishEvent(type, payload, context),
    async (schedule, taskId) => {
      const created = runtime.createSession(`Background: ${schedule.name}`);
      const run = runtime.startRun({
        threadId: created.thread.id,
        input: schedule.agentInput,
        provider: effectiveConfig.provider.name,
        model: effectiveConfig.provider.model,
      });
      scheduledRuns.set(taskId, run.id);
      try {
        await runtime.waitForRun(run.id);
      } finally {
        scheduledRuns.delete(taskId);
      }
    },
    (taskId) => {
      const runId = scheduledRuns.get(taskId);
      if (runId) runtime.cancelRun(runId);
    },
  );
  const daemonLock = await acquireDaemonLock(resolvedRoot);
  let gateway: GatewayHandle;
  try {
    scheduler.start();
    gateway = await startServer({
      root: resolvedRoot,
      host: effectiveConfig.host,
      port: effectiveConfig.port,
      authSecret: identity.secret,
      authToken: identity.token,
      runtime,
      store,
      providers,
      scheduler,
      skills,
      plugins,
      secrets,
    });
  } catch (error) {
    scheduler.stop();
    await daemonLock.release();
    store.close();
    throw error;
  }
  if (effectiveConfig.features.matrix && effectiveConfig.matrix.enabled && !matrix)
    process.stderr.write(
      'Matrix integration disabled: configure NUAAI_MATRIX_ACCESS_TOKEN and matrix.userId.\n',
    );
  if (matrix) {
    void matrix.start(async (message) => {
      if (effectiveConfig.matrix.roomId && effectiveConfig.matrix.roomId !== message.roomId) return;
      const created = runtime.createSession(`Matrix ${message.roomId}`);
      const run = runtime.startRun({
        threadId: created.thread.id,
        input: message.body,
        permissions: {
          approved: new Set(['read']),
          capabilities: { filesystem: true, network: true },
        },
      });
      const completed = await runtime.waitForRun(run.id);
      const output = completed.output?.trim() || 'NUAAI completed the run without text output.';
      await matrix.sendText(message.roomId, output.slice(0, 60_000));
    });
  }
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    matrix?.stop();
    scheduler.stop();
    await gateway.close();
    store.close();
    await daemonLock.release();
  };
  process.once('SIGINT', () => {
    void stop().then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void stop().then(() => process.exit(0));
  });
  process.stdout.write(
    `NUAAI daemon listening on http://${effectiveConfig.host}:${gateway.port}\n`,
  );
  return { gateway, runtime, scheduler, store, token: identity.token, matrix, stop };
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint)
  void startDaemon().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
