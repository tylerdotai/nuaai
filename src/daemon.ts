import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntimeConfig, workspaceDirectory } from './config/index.js';
import { loadSessionIdentity } from './core/identity.js';
import { AgentRuntime } from './core/runtime.js';
import { Scheduler } from './core/scheduler.js';
import { acquireDaemonLock } from './gateway/lock.js';
import { ensureRuntimeIdentity } from './gateway/runtime.js';
import { MatrixBridge, matrixHelpText, parseMatrixCommand } from './integrations/matrix.js';
import { McpManager } from './integrations/mcp.js';
import {
  Crawl4AiClient,
  FlareSolverrClient,
  SearchStack,
  SearxngSearchClient,
} from './integrations/search.js';
import { DatabaseStore, openAppDatabase } from './memory/db.js';
import { PluginRegistry } from './plugins/registry.js';
import { ProviderRegistry } from './providers/registry.js';
import type { ProviderImage } from './providers/types.js';
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
  mcp: McpManager;
  stop(): Promise<void>;
}

const maxOllamaImageBytes = 10_000_000;

export async function startDaemon(root = process.cwd()): Promise<DaemonHandle> {
  const resolvedRoot = resolve(root);
  await initWorkspace(resolvedRoot);
  const matrixSincePath = resolve(workspaceDirectory(resolvedRoot), 'matrix-since.txt');
  let matrixSince: string | undefined;
  try {
    matrixSince = (await readFile(matrixSincePath, 'utf8')).trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let matrixSinceWrite = Promise.resolve();
  const persistMatrixSince = (since: string): void => {
    matrixSinceWrite = matrixSinceWrite
      .catch(() => undefined)
      .then(() => writeFile(matrixSincePath, since, { encoding: 'utf8', mode: 0o600 }));
    void matrixSinceWrite.catch((error: unknown) => {
      process.stderr.write(`Matrix sync state unavailable: ${String(error)}\n`);
    });
  };
  const config = await loadRuntimeConfig(resolvedRoot);
  const effectiveConfig =
    process.env.NUAAI_TEST_MODE === '1'
      ? {
          ...config,
          provider: { ...config.provider, name: 'deterministic', model: 'deterministic' },
        }
      : config;
  const identity = ensureRuntimeIdentity(resolvedRoot);
  const sessionIdentity = loadSessionIdentity(resolvedRoot);
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
  const mcp = new McpManager(effectiveConfig.mcp);
  await mcp.start();
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
    identityContext: sessionIdentity,
    mcp,
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
          since: matrixSince,
          onSince: persistMatrixSince,
          downloadDirectory: resolve(workspaceDirectory(resolvedRoot), 'attachments', 'incoming'),
          workspaceRoot: resolvedRoot,
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
      mcp,
    });
  } catch (error) {
    mcp.stop();
    scheduler.stop();
    await daemonLock.release();
    store.close();
    throw error;
  }
  if (effectiveConfig.features.matrix && effectiveConfig.matrix.enabled && !matrix)
    process.stderr.write(
      'Matrix integration disabled: configure NUAAI_MATRIX_ACCESS_TOKEN and matrix.userId.\n',
    );
  let unsubscribeMatrixRuntime: (() => void) | undefined;
  if (matrix) {
    type MatrixProgress = {
      roomId: string;
      eventId?: string;
      pending?: string;
      timer?: ReturnType<typeof setTimeout>;
      unavailable?: boolean;
    };
    const progressByThread = new Map<string, MatrixProgress>();
    const progressByRun = new Map<string, MatrixProgress>();
    const reportMatrixSignalFailure = (kind: string, error: unknown): void => {
      process.stderr.write(
        `[Matrix] ${kind} unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    };
    const bestEffortMatrix = async (kind: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        reportMatrixSignalFailure(kind, error);
      }
    };
    const flushProgress = async (progress: MatrixProgress): Promise<void> => {
      if (progress.timer) {
        clearTimeout(progress.timer);
        progress.timer = undefined;
      }
      if (progress.unavailable || !progress.pending) return;
      const body = progress.pending;
      try {
        if (progress.eventId) await matrix.editText(progress.roomId, progress.eventId, body);
        else progress.eventId = (await matrix.sendText(progress.roomId, body)).eventId;
        if (progress.pending === body) progress.pending = undefined;
      } catch (error) {
        progress.unavailable = true;
        reportMatrixSignalFailure('progress message', error);
      }
    };
    const scheduleProgress = (progress: MatrixProgress, body: string): void => {
      if (progress.unavailable) return;
      progress.pending = body;
      if (progress.timer) return;
      progress.timer = setTimeout(() => {
        progress.timer = undefined;
        void flushProgress(progress);
      }, 2_000);
    };
    const unsubscribe = runtime.subscribe((event) => {
      if (!['tool.started', 'tool.completed', 'tool.failed'].includes(event.type)) return;
      const progress =
        (event.runId ? progressByRun.get(event.runId) : undefined) ??
        (event.threadId ? progressByThread.get(event.threadId) : undefined);
      if (!progress) return;
      const name = typeof event.payload.name === 'string' ? event.payload.name : 'tool';
      if (event.type === 'tool.started') scheduleProgress(progress, `🔧 Running ${name}…`);
      else if (event.type === 'tool.completed') scheduleProgress(progress, `✅ ${name} complete`);
      else scheduleProgress(progress, `⚠️ ${name} failed`);
    });
    void matrix.start(async (message) => {
      try {
        if (effectiveConfig.matrix.roomId && effectiveConfig.matrix.roomId !== message.roomId)
          return;
        await bestEffortMatrix('read receipt', () =>
          matrix.sendReceipt(message.roomId, message.eventId),
        );
        const sourceKey = `matrix:${message.roomId}:${message.sender}`;
        const command = parseMatrixCommand(message.body);
        if (command) {
          if (command.name === 'help' || command.name === 'start') {
            await matrix.sendText(message.roomId, matrixHelpText());
            return;
          }
          if (command.name === 'status') {
            const session = runtime
              .listSessions()
              .find((candidate) => candidate.sourceKey === sourceKey);
            await matrix.sendText(
              message.roomId,
              session
                ? `Active session: **${session.title}**\nID: \`${session.id}\``
                : 'No active session for this room and sender. Send a normal message to create one.',
            );
            return;
          }
          if (command.name === 'sessions') {
            const sessions = runtime
              .listSessions()
              .filter((session) => session.sourceKey?.startsWith(`matrix:${message.roomId}:`));
            await matrix.sendText(
              message.roomId,
              sessions.length
                ? sessions.map((session) => `- ${session.id} — ${session.title}`).join('\n')
                : 'No Matrix sessions found for this room.',
            );
            return;
          }
          if (command.name === 'new') {
            const title = command.args.join(' ').trim() || 'New Matrix session';
            const created = runtime.startNewSession(sourceKey, title);
            await matrix.sendText(
              message.roomId,
              `Started session **${created.session.title}** (${created.session.id}).`,
            );
            return;
          }
          if (command.name === 'switch') {
            if (command.args.length !== 1) {
              await matrix.sendText(message.roomId, 'Usage: `/switch <session-id>`');
              return;
            }
            try {
              const switched = runtime.switchSession(sourceKey, command.args[0]);
              await matrix.sendText(
                message.roomId,
                `Switched to **${switched.session.title}** (${switched.session.id}).`,
              );
            } catch (error) {
              await matrix.sendText(
                message.roomId,
                `Session switch failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            return;
          }
          await matrix.sendText(
            message.roomId,
            `Unknown command: "/${command.name}"\n\n${matrixHelpText()}`,
          );
          return;
        }
        const created = runtime.getOrCreateSession(sourceKey, `Matrix ${message.roomId}`);
        process.stdout.write(
          `[Matrix] received room=${message.roomId} sender=${message.sender} event=${message.eventId}\n`,
        );
        await bestEffortMatrix('typing notification', () => matrix.setTyping(message.roomId, true));
        const progress: MatrixProgress = {
          roomId: message.roomId,
          pending: '🧠 NUAAI is working on this…',
        };
        progressByThread.set(created.thread.id, progress);
        await flushProgress(progress);
        const images: ProviderImage[] = [];
        for (const attachment of message.attachments ?? []) {
          if (
            !attachment.localPath ||
            attachment.error ||
            !attachment.mimeType?.startsWith('image/')
          )
            continue;
          try {
            const bytes = await readFile(attachment.localPath);
            if (bytes.byteLength > maxOllamaImageBytes) {
              attachment.error = 'Image exceeds the Ollama vision size limit';
              continue;
            }
            images.push({
              name: attachment.name,
              mimeType: attachment.mimeType,
              data: bytes.toString('base64'),
            });
          } catch (error) {
            attachment.error = error instanceof Error ? error.message : String(error);
          }
        }
        const attachmentContext = message.attachments?.map((attachment) =>
          attachment.localPath && !attachment.error
            ? attachment.mimeType?.startsWith('image/')
              ? `Attachment ${attachment.name}: image available to the vision model.`
              : `Attachment ${attachment.name}: ${attachment.localPath}`
            : `Attachment ${attachment.name}: unavailable (${attachment.error ?? 'not downloaded'})`,
        );
        let runId: string | undefined;
        try {
          const run = runtime.startRun({
            threadId: created.thread.id,
            input: [message.body, ...(attachmentContext ?? [])].join('\n'),
            permissions: {
              approved: new Set(['read', 'write', 'execute']),
              capabilities: { filesystem: true, subprocess: true, network: true },
            },
            ...(images.length ? { images } : {}),
          });
          runId = run.id;
          progressByRun.set(run.id, progress);
          const completed = await runtime.waitForRun(run.id);
          process.stdout.write(
            `[Matrix] run=${run.id} status=${completed.status} outputChars=${completed.output.length}\n`,
          );
          const output =
            completed.status === 'completed'
              ? completed.output.trim() || 'NUAAI completed the run without text output.'
              : `NUAAI run ${completed.status}. The run did not complete successfully.`;
          scheduleProgress(
            progress,
            completed.status === 'completed' ? '✅ NUAAI finished' : `⚠️ NUAAI ${completed.status}`,
          );
          await flushProgress(progress);
          await matrix.sendOutput(message.roomId, output.slice(0, 60_000));
        } finally {
          if (progress.timer) clearTimeout(progress.timer);
          progressByThread.delete(created.thread.id);
          if (runId) progressByRun.delete(runId);
          await bestEffortMatrix('typing notification', () =>
            matrix.setTyping(message.roomId, false),
          );
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[Matrix] message delivery failed room=${message.roomId} event=${message.eventId}: ${detail}\n`,
        );
        await bestEffortMatrix('error response', async () => {
          await matrix.sendText(
            message.roomId,
            'NUAAI could not complete or deliver this response.',
          );
        });
      }
    });
    unsubscribeMatrixRuntime = unsubscribe;
  }
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    matrix?.stop();
    unsubscribeMatrixRuntime?.();
    mcp.stop();
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
  return { gateway, runtime, scheduler, store, token: identity.token, matrix, mcp, stop };
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint)
  void startDaemon().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
