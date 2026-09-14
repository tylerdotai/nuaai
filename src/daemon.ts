import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntimeConfig, persistProviderSelection, workspaceDirectory } from './config/index.js';
import { loadSessionIdentity } from './core/identity.js';
import { AgentRuntime } from './core/runtime.js';
import { Scheduler } from './core/scheduler.js';
import { type DaemonLock, acquireDaemonLock } from './gateway/lock.js';
import { ensureRuntimeIdentity } from './gateway/runtime.js';
import { ExternalAgentDispatcher } from './integrations/agents.js';
import { LocalAudioBridge, handleAudioCommand } from './integrations/audio.js';
import { MatrixReactionCoordinator } from './integrations/matrix-reactions.js';
import {
  MatrixBridge,
  matrixConversationThreadSourceKey,
  matrixHelpText,
  matrixProgressText,
  matrixReplyOptions,
  matrixTerminalProgress,
  parseMatrixCommand,
} from './integrations/matrix.js';
import { McpManager } from './integrations/mcp.js';
import { MediaProcessor } from './integrations/media.js';
import { SearchStack, SearxngSearchClient } from './integrations/search.js';
import { DatabaseStore, openAppDatabase } from './memory/db.js';
import { PluginRegistry } from './plugins/registry.js';
import { ProviderRegistry } from './providers/registry.js';
import type { ProviderImage } from './providers/types.js';
import { permissionContextForProfile } from './security/permissions.js';
import { SecretsManager } from './security/secrets.js';
import { type GatewayHandle, startServer } from './server.js';
import { SkillLearner } from './skills/learner.js';
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
const packageRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export async function startDaemon(root = process.cwd()): Promise<DaemonHandle> {
  const resolvedRoot = resolve(root);
  const daemonLock = await acquireDaemonLock(resolvedRoot);
  try {
    return await startOwnedDaemon(resolvedRoot, daemonLock);
  } catch (error) {
    await daemonLock.release();
    throw error;
  }
}

async function startOwnedDaemon(
  resolvedRoot: string,
  daemonLock: DaemonLock,
): Promise<DaemonHandle> {
  await initWorkspace(resolvedRoot);
  const matrixSincePath = resolve(workspaceDirectory(resolvedRoot), 'matrix-since.txt');
  let matrixSince: string | undefined;
  try {
    matrixSince = (await readFile(matrixSincePath, 'utf8')).trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let matrixSinceWrite = Promise.resolve();
  const persistMatrixSince = async (since: string): Promise<void> => {
    matrixSinceWrite = matrixSinceWrite
      .catch(() => undefined)
      .then(() => writeFile(matrixSincePath, since, { encoding: 'utf8', mode: 0o600 }));
    await matrixSinceWrite;
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
    selectedModels: effectiveConfig.provider.selectedModels,
    baseUrl: effectiveConfig.provider.baseUrl,
    embeddingModel: effectiveConfig.embedding.model,
    embeddingBaseUrl: effectiveConfig.embedding.baseUrl,
    contextWindow: effectiveConfig.provider.contextWindow,
    codex: effectiveConfig.provider.codex,
    timeoutMs: effectiveConfig.limits.providerTimeoutMs,
    ollamaEnabled: effectiveConfig.features.ollama,
    codexEnabled: effectiveConfig.features.codex,
    persistSelection: (provider, model) => persistProviderSelection(resolvedRoot, provider, model),
  });
  const search =
    effectiveConfig.features.search || effectiveConfig.features.browser
      ? new SearchStack({
          searxng: new SearxngSearchClient(effectiveConfig.search.searxngUrl),
          browser: effectiveConfig.features.browser ? undefined : null,
        })
      : undefined;
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
  await loadFilesystemSkills(resolvedRoot, skills, store, resolve(packageRoot, 'skills'));
  const skillLearner = new SkillLearner(resolvedRoot, skills);
  const plugins = new PluginRegistry(resolvedRoot, store);
  await plugins.load();
  let runtime!: AgentRuntime;
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
          allowedUsers: effectiveConfig.matrix.allowedUsers,
          allowedRooms: effectiveConfig.matrix.allowedRooms,
          freeResponseRooms: effectiveConfig.matrix.freeResponseRooms,
          ignoreUserPatterns: effectiveConfig.matrix.ignoreUserPatterns,
          requireMention: effectiveConfig.matrix.requireMention,
          processNotices: effectiveConfig.matrix.processNotices,
          allowRoomMentions: effectiveConfig.matrix.allowRoomMentions,
          autoThread: effectiveConfig.matrix.autoThread,
          reactions: effectiveConfig.matrix.reactions,
          maxMessageLength: effectiveConfig.matrix.maxMessageLength,
        })
      : undefined;
  const audio = new LocalAudioBridge({
    pythonCommand: effectiveConfig.audio.pythonCommand,
    scriptPath: resolve(resolvedRoot, effectiveConfig.audio.scriptPath),
    allowedRoot: resolvedRoot,
    outputDirectory: resolve(resolvedRoot, effectiveConfig.audio.outputDirectory),
    model: effectiveConfig.audio.model,
    device: effectiveConfig.audio.device,
    computeType: effectiveConfig.audio.computeType,
    voice: effectiveConfig.audio.voice,
    kokoroModelPath: effectiveConfig.audio.kokoroModelPath,
    kokoroVoicesPath: effectiveConfig.audio.kokoroVoicesPath,
    timeoutMs: effectiveConfig.audio.timeoutMs,
  });
  const media = new MediaProcessor({
    allowedRoot: resolvedRoot,
    artifactDirectory: resolve(resolvedRoot, '.nuaai/media'),
    timeoutMs: effectiveConfig.limits.toolTimeoutMs,
  });
  const agents = new ExternalAgentDispatcher(resolvedRoot, effectiveConfig.agents);
  const voiceState = {
    voiceEnabled: effectiveConfig.audio.voiceEnabled,
    ttsEnabled: effectiveConfig.audio.ttsEnabled,
  };
  const scheduledRuns = new Map<string, string>();
  const scheduler = new Scheduler(
    store,
    (type, payload, context) => runtime.publishEvent(type, payload, context),
    async (schedule, taskId) => {
      const created = runtime.getOrCreateSession(
        `schedule:${schedule.id}`,
        `Background: ${schedule.name}`,
      );
      const run = runtime.startRun({
        threadId: created.thread.id,
        input: schedule.agentInput,
        permissions: permissionContextForProfile(effectiveConfig.permissions.scheduler),
      });
      scheduledRuns.set(taskId, run.id);
      try {
        return await runtime.waitForRun(run.id);
      } finally {
        scheduledRuns.delete(taskId);
      }
    },
    (taskId) => {
      const runId = scheduledRuns.get(taskId);
      if (runId) runtime.cancelRun(runId);
    },
  );
  const tools = new ToolRegistry(
    resolvedRoot,
    search,
    {
      browserEnabled: effectiveConfig.features.browser,
      searchEnabled: effectiveConfig.features.search,
    },
    { store, scheduler, providers, mcp, media, agents },
  );
  runtime = new AgentRuntime({
    root: resolvedRoot,
    config: effectiveConfig,
    store,
    providers,
    tools,
    identityContext: sessionIdentity,
    mcp,
    skills,
    skillLearner,
  });
  let gateway: GatewayHandle;
  try {
    scheduler.start();
    gateway = await startServer({
      root: resolvedRoot,
      host: effectiveConfig.host,
      port: effectiveConfig.port,
      authSecret: identity.secret,
      browserCookiePath: effectiveConfig.web.publicBasePath,
      runPermissionProfile: effectiveConfig.permissions.web,
      runPermissions: permissionContextForProfile(effectiveConfig.permissions.web),
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
    await runtime.shutdown();
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
      sourceEventId: string;
      threadRootEventId?: string;
      eventId?: string;
      reactionCoordinator?: MatrixReactionCoordinator;
      pending?: string;
      timer?: ReturnType<typeof setTimeout>;
      typingTimer?: ReturnType<typeof setInterval>;
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
    const setStatusReaction = async (progress: MatrixProgress, key: string): Promise<void> => {
      if (!effectiveConfig.matrix.reactions) return;
      progress.reactionCoordinator ??= new MatrixReactionCoordinator(
        async (statusKey) =>
          (await matrix.sendReaction(progress.roomId, progress.sourceEventId, statusKey)).eventId,
        (eventId) =>
          bestEffortMatrix('status reaction cleanup', () =>
            matrix.redact(progress.roomId, eventId),
          ),
      );
      await progress.reactionCoordinator.set(key);
    };
    const startTyping = (progress: MatrixProgress): void => {
      void bestEffortMatrix('typing notification', () => matrix.setTyping(progress.roomId, true));
      progress.typingTimer = setInterval(() => {
        void bestEffortMatrix('typing notification refresh', () =>
          matrix.setTyping(progress.roomId, true),
        );
      }, 10_000);
    };
    const stopTyping = async (progress: MatrixProgress): Promise<void> => {
      if (progress.typingTimer) clearInterval(progress.typingTimer);
      progress.typingTimer = undefined;
      await bestEffortMatrix('typing notification', () => matrix.setTyping(progress.roomId, false));
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
        else
          progress.eventId = (
            await matrix.sendText(
              progress.roomId,
              body,
              progress.threadRootEventId ? { threadRootEventId: progress.threadRootEventId } : {},
            )
          ).eventId;
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
      if (
        ![
          'run.started',
          'run.completed',
          'run.failed',
          'run.cancelled',
          'tool.started',
          'tool.completed',
          'tool.failed',
        ].includes(event.type)
      )
        return;
      const progress =
        (event.runId ? progressByRun.get(event.runId) : undefined) ??
        (event.threadId ? progressByThread.get(event.threadId) : undefined);
      if (!progress) return;
      const name =
        typeof event.payload.name === 'string'
          ? event.payload.name
          : typeof event.payload.error === 'string'
            ? event.payload.error
            : 'tool';
      const progressText = matrixProgressText(event.type, name);
      if (progressText) scheduleProgress(progress, progressText);
      if (event.type === 'run.started') {
        void bestEffortMatrix('status reaction', () => setStatusReaction(progress, '🧠'));
      } else if (event.type === 'run.completed') {
        void bestEffortMatrix('status reaction', () => setStatusReaction(progress, '✅'));
      } else if (
        event.type === 'run.cancelled' ||
        event.type === 'run.failed' ||
        event.type === 'tool.failed'
      ) {
        void bestEffortMatrix('status reaction', () => setStatusReaction(progress, '⚠️'));
      }
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
          const replyOptions = matrixReplyOptions(message);
          const audioCommandResponse = handleAudioCommand(command.name, command.args, voiceState);
          if (audioCommandResponse) {
            await matrix.sendText(message.roomId, audioCommandResponse, replyOptions);
            return;
          }
          if (command.name === 'help' || command.name === 'start') {
            await matrix.sendText(message.roomId, matrixHelpText(), replyOptions);
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
              replyOptions,
            );
            return;
          }
          if (command.name === 'sessions') {
            const sessions = runtime.listSessionsForSource(sourceKey);
            await matrix.sendText(
              message.roomId,
              sessions.length
                ? sessions.map((session) => `- ${session.id} — ${session.title}`).join('\n')
                : 'No Matrix sessions found for this room.',
              replyOptions,
            );
            return;
          }
          if (command.name === 'new') {
            const title = command.args.join(' ').trim() || 'New Matrix session';
            const created = runtime.startNewSession(sourceKey, title, `matrix:${message.eventId}`);
            await matrix.sendText(
              message.roomId,
              `Started session **${created.session.title}** (${created.session.id}).`,
              replyOptions,
            );
            return;
          }
          if (command.name === 'switch') {
            if (command.args.length !== 1) {
              await matrix.sendText(message.roomId, 'Usage: `/switch <session-id>`', replyOptions);
              return;
            }
            try {
              const switched = runtime.switchSession(sourceKey, command.args[0]);
              await matrix.sendText(
                message.roomId,
                `Switched to **${switched.session.title}** (${switched.session.id}).`,
                replyOptions,
              );
            } catch (error) {
              await matrix.sendText(
                message.roomId,
                `Session switch failed: ${error instanceof Error ? error.message : String(error)}`,
                replyOptions,
              );
            }
            return;
          }
          await matrix.sendText(
            message.roomId,
            `Unknown command: "/${command.name}"\n\n${matrixHelpText()}`,
            replyOptions,
          );
          return;
        }
        const created = runtime.getOrCreateSession(sourceKey, `Matrix ${message.roomId}`);
        const responseThreadRootEventId = effectiveConfig.matrix.autoThread
          ? (message.threadRootEventId ?? message.eventId)
          : message.threadRootEventId;
        const threadSourceKey = matrixConversationThreadSourceKey(
          sourceKey,
          message,
          effectiveConfig.matrix.autoThread ?? false,
        );
        const thread = runtime.getOrCreateThread(
          created.session.id,
          threadSourceKey,
          responseThreadRootEventId ? `Matrix thread ${responseThreadRootEventId}` : 'Main thread',
        );
        process.stdout.write(
          `[Matrix] received room=${message.roomId} sender=${message.sender} event=${message.eventId} thread=${thread.id}\n`,
        );
        const progress: MatrixProgress = {
          roomId: message.roomId,
          sourceEventId: message.eventId,
          ...(responseThreadRootEventId ? { threadRootEventId: responseThreadRootEventId } : {}),
        };
        progressByThread.set(thread.id, progress);
        startTyping(progress);
        const images: ProviderImage[] = [];
        const transcriptions: string[] = [];
        const attachmentContext: string[] = [];
        for (const attachment of message.attachments ?? []) {
          if (!attachment.localPath || attachment.error) {
            attachmentContext.push(
              `Attachment ${attachment.name}: unavailable (${attachment.error ?? 'not downloaded'})`,
            );
            continue;
          }
          const mimeType = attachment.mimeType ?? 'application/octet-stream';
          try {
            if (mimeType.startsWith('image/')) {
              const bytes = await readFile(attachment.localPath);
              if (bytes.byteLength > maxOllamaImageBytes)
                throw new Error('Image exceeds the Ollama vision size limit');
              if (images.length >= 8)
                throw new Error('The run already contains the maximum of 8 images');
              images.push({
                name: attachment.name,
                mimeType,
                data: bytes.toString('base64'),
              });
              attachmentContext.push(
                `Attachment ${attachment.name}: image available to the vision model.`,
              );
              continue;
            }
            if (mimeType.startsWith('video/')) {
              const inspection = await media.inspect(attachment.localPath, {
                extractAudio: voiceState.voiceEnabled,
                extractFrames: true,
              });
              for (const [index, frame] of (inspection.frames ?? []).entries()) {
                if (images.length >= 8) break;
                const bytes = await readFile(frame.path);
                if (bytes.byteLength <= maxOllamaImageBytes)
                  images.push({
                    name: `${attachment.name} frame ${index + 1}`,
                    mimeType: frame.mimeType,
                    data: bytes.toString('base64'),
                  });
              }
              if (voiceState.voiceEnabled) {
                const speechPath = inspection.audioPath ?? attachment.localPath;
                const transcript = await audio.transcribe(speechPath);
                if (transcript.text)
                  transcriptions.push(`Transcript from ${attachment.name}: ${transcript.text}`);
              }
              attachmentContext.push(
                `Attachment ${attachment.name}: video inspected with ${(inspection.frames ?? []).length} bounded frame(s) available to the vision model${voiceState.voiceEnabled ? ' and audio transcription below' : '; audio transcription disabled'}.`,
              );
              continue;
            }
            if (mimeType.startsWith('audio/')) {
              if (!voiceState.voiceEnabled) {
                attachmentContext.push(
                  `Attachment ${attachment.name}: audio received; voice input is disabled.`,
                );
                continue;
              }
              const transcript = await audio.transcribe(attachment.localPath);
              if (transcript.text) {
                transcriptions.push(`Transcript from ${attachment.name}: ${transcript.text}`);
                attachmentContext.push(`Attachment ${attachment.name}: audio transcribed below.`);
              } else {
                attachmentContext.push(`Attachment ${attachment.name}: no speech was detected.`);
              }
              continue;
            }
            const inspection = await media.inspect(attachment.localPath);
            if (inspection.text) {
              attachmentContext.push(`Extracted text from ${attachment.name}:\n${inspection.text}`);
            } else {
              attachmentContext.push(
                `Attachment ${attachment.name}: ${inspection.kind} metadata inspected.`,
              );
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            attachment.error = detail;
            attachmentContext.push(`Attachment ${attachment.name}: unavailable (${detail})`);
          }
        }

        let runId: string | undefined;
        try {
          const run = runtime.startRun({
            threadId: thread.id,
            input: [message.body, ...(attachmentContext ?? []), ...transcriptions].join('\n'),
            idempotencyKey: `matrix:${message.eventId}`,
            permissions: permissionContextForProfile(effectiveConfig.permissions.matrix),
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
              : completed.output.trim() ||
                `NUAAI run ${completed.status}. The run did not complete successfully.`;
          await bestEffortMatrix('status reaction', () =>
            setStatusReaction(
              progress,
              completed.status === 'completed'
                ? '✅'
                : completed.status === 'cancelled'
                  ? '🛑'
                  : '⚠️',
            ),
          );
          const terminalProgress = matrixTerminalProgress(completed.status);
          if (terminalProgress) scheduleProgress(progress, terminalProgress);
          await flushProgress(progress);
          await matrix.sendOutput(message.roomId, output, {
            ...(progress.threadRootEventId
              ? { threadRootEventId: progress.threadRootEventId }
              : {}),
            transactionId: `run-${run.id}-output`,
          });
          if (voiceState.ttsEnabled && completed.status === 'completed') {
            try {
              const speech = await audio.synthesize(output.slice(0, 20_000));
              await matrix.sendAudio(
                message.roomId,
                speech.path,
                progress.threadRootEventId ? { threadRootEventId: progress.threadRootEventId } : {},
              );
            } catch (error) {
              reportMatrixSignalFailure('voice response', error);
            }
          }
        } finally {
          if (progress.timer) clearTimeout(progress.timer);
          await stopTyping(progress);
          progressByThread.delete(thread.id);
          if (runId) progressByRun.delete(runId);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[Matrix] message delivery failed room=${message.roomId} event=${message.eventId}: ${detail}\n`,
        );
        throw error;
      }
    });
    unsubscribeMatrixRuntime = unsubscribe;
  }
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    matrix?.stop();
    await matrixSinceWrite;
    unsubscribeMatrixRuntime?.();
    scheduler.stop();
    await runtime.shutdown();
    mcp.stop();
    await gateway.close();
    await providers.close();
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
