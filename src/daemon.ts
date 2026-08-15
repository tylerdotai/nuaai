import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntimeConfig } from './config/index.js';
import { AgentRuntime } from './core/runtime.js';
import { Scheduler } from './core/scheduler.js';
import { acquireDaemonLock } from './gateway/lock.js';
import { ensureRuntimeIdentity } from './gateway/runtime.js';
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
  stop(): Promise<void>;
}

export async function startDaemon(root = process.cwd()): Promise<DaemonHandle> {
  const resolvedRoot = resolve(root);
  await initWorkspace(resolvedRoot);
  const config = await loadRuntimeConfig(resolvedRoot);
  const effectiveConfig =
    process.env.NUAI_TEST_MODE === '1'
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
  });
  const tools = new ToolRegistry(resolvedRoot);
  const skills = new SkillRegistry();
  skills.register({
    name: 'workspace-status',
    description: 'Return the current NUAI workspace root',
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
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
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
  process.stdout.write(`NUAI daemon listening on http://${effectiveConfig.host}:${gateway.port}\n`);
  return { gateway, runtime, scheduler, store, token: identity.token, stop };
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint)
  void startDaemon().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
