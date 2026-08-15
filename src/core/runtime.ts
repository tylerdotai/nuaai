import { randomUUID } from 'node:crypto';

import type { RuntimeConfig } from '../config/index.js';
import type { McpManager } from '../integrations/mcp.js';
import type { DatabaseStore, RunRow, SessionRow, ThreadRow } from '../memory/db.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderAdapter, ProviderImage, ProviderMessage } from '../providers/types.js';
import type { PermissionContext } from '../security/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { type EventRecord, createEvent } from './events.js';

export interface RuntimeOptions {
  root: string;
  config: RuntimeConfig;
  store: DatabaseStore;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  identityContext?: string;
  mcp?: McpManager;
}
export interface RunRequest {
  threadId: string;
  input: string;
  images?: ProviderImage[];
  provider?: string;
  model?: string;
  permissions?: PermissionContext;
}
export type RuntimeListener = (event: EventRecord & { id: number }) => void;

function selectContextMessages<T extends { role: string; content: string }>(
  messages: T[],
  maxBytes: number,
): T[] {
  const selected: T[] = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageBytes = Buffer.byteLength(message.content, 'utf8') + 32;
    if (selected.length && bytes + messageBytes > maxBytes) break;
    selected.unshift(message);
    bytes += messageBytes;
  }
  return selected;
}

function isCapabilityRefusal(value: string): boolean {
  return /\b(?:i\s+(?:can't|cannot|do not|don't)\s+(?:access|create|send|read|run|have)|what\s+i\s+cannot|not able to|without direct access)\b/i.test(
    value,
  );
}

export class AgentRuntime {
  private readonly listeners = new Set<RuntimeListener>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly options: RuntimeOptions) {
    this.recoverActiveRuns();
  }

  private recoverActiveRuns(): void {
    for (const run of this.options.store.listActiveRuns()) {
      try {
        const provider = this.options.providers.get(run.provider);
        this.emit(
          'run.resumed',
          { provider: run.provider, model: run.model, reason: 'daemon_restart' },
          { threadId: run.threadId, runId: run.id, correlationId: run.correlationId },
        );
        void this.executeRun(run, provider, {
          approved: new Set(['read', 'write', 'execute']),
          capabilities: { filesystem: true, subprocess: true, network: true },
        });
      } catch (error) {
        this.options.store.updateRun(run.id, {
          status: 'failed',
          output: run.output,
        });
        this.emit(
          'run.failed',
          { error: error instanceof Error ? error.message : String(error), reason: 'recovery' },
          { threadId: run.threadId, runId: run.id, correlationId: run.correlationId },
        );
      }
    }
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishEvent(
    type: EventRecord['type'],
    payload: Record<string, unknown>,
    context: Partial<
      Pick<EventRecord, 'sessionId' | 'threadId' | 'runId' | 'taskId' | 'correlationId' | 'source'>
    > = {},
  ): void {
    this.emit(type, payload, context);
  }

  private emit(
    type: EventRecord['type'],
    payload: Record<string, unknown>,
    context: Partial<
      Pick<EventRecord, 'sessionId' | 'threadId' | 'runId' | 'taskId' | 'correlationId' | 'source'>
    > = {},
  ): void {
    const event = this.options.store.appendEvent(createEvent(type, payload, context));
    for (const listener of this.listeners) listener(event);
  }

  createSession(title?: string, sourceKey?: string): { session: SessionRow; thread: ThreadRow } {
    const created = this.options.store.createSession(
      title,
      Date.now(),
      this.options.identityContext ?? '',
      sourceKey,
    );
    this.emit(
      'session.created',
      { title: created.session.title },
      { sessionId: created.session.id },
    );
    this.emit(
      'thread.created',
      { title: created.thread.title },
      { sessionId: created.session.id, threadId: created.thread.id },
    );
    return created;
  }

  getOrCreateSession(
    sourceKey: string,
    title?: string,
  ): { session: SessionRow; thread: ThreadRow } {
    const existing = this.options.store.getSessionBySource(sourceKey);
    if (existing) {
      const thread = this.options.store.listThreads(existing.id)[0];
      if (!thread) throw new Error(`Session has no thread: ${existing.id}`);
      this.emit('session.resumed', { title: existing.title }, { sessionId: existing.id });
      return { session: existing, thread };
    }
    return this.createSession(title, sourceKey);
  }

  startNewSession(sourceKey: string, title?: string): { session: SessionRow; thread: ThreadRow } {
    const existing = this.options.store.getSessionBySource(sourceKey);
    if (existing) this.options.store.setSessionSourceKey(existing.id, null);
    return this.createSession(title ?? 'New session', sourceKey);
  }

  switchSession(sourceKey: string, sessionId: string): { session: SessionRow; thread: ThreadRow } {
    const target = this.options.store.getSession(sessionId);
    if (!target) throw new Error(`Unknown session: ${sessionId}`);
    const thread = this.options.store.listThreads(sessionId)[0];
    if (!thread) throw new Error(`Session has no thread: ${sessionId}`);
    const current = this.options.store.getSessionBySource(sourceKey);
    if (current && current.id !== sessionId)
      this.options.store.setSessionSourceKey(current.id, null);
    this.options.store.setSessionSourceKey(sessionId, sourceKey);
    const resumed = this.options.store.getSession(sessionId) ?? target;
    this.emit('session.resumed', { title: resumed.title }, { sessionId: resumed.id });
    return { session: resumed, thread };
  }

  listSessions(): SessionRow[] {
    return this.options.store.listSessions();
  }
  getSession(id: string): SessionRow | undefined {
    return this.options.store.getSession(id);
  }
  listThreads(sessionId: string): ThreadRow[] {
    return this.options.store.listThreads(sessionId);
  }
  createThread(sessionId: string, title?: string): ThreadRow {
    const thread = this.options.store.createThread(sessionId, title);
    this.emit('thread.created', { title: thread.title }, { sessionId, threadId: thread.id });
    return thread;
  }
  listMessages(threadId: string) {
    return this.options.store.listMessages(threadId);
  }

  startRun(request: RunRequest): RunRow {
    if (!request.input.trim()) throw new Error('Run input is required');
    const providerName = request.provider ?? this.options.config.provider.name;
    const provider = this.options.providers.get(providerName);
    const model = request.model ?? provider.model;
    const thread = this.options.store.getThread(request.threadId);
    if (!thread) throw new Error(`Unknown thread: ${request.threadId}`);
    const correlationId = randomUUID();
    const run = this.options.store.createRun(
      thread.id,
      request.input,
      provider.name,
      model,
      correlationId,
    );
    this.options.store.addMessage(thread.id, 'user', request.input, provider.name, model);
    this.emit(
      'run.created',
      { input: request.input, provider: provider.name, model },
      { sessionId: thread.sessionId, threadId: thread.id, runId: run.id, correlationId },
    );
    void this.executeRun(
      run,
      provider,
      request.permissions ?? {
        approved: new Set(['read', 'write', 'execute']),
        capabilities: { filesystem: true, subprocess: true, network: true },
      },
      request.images,
    );
    return run;
  }

  cancelRun(runId: string): void {
    const run = this.options.store.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    this.options.store.requestRunCancel(runId);
    this.controllers.get(runId)?.abort(new Error('Run cancelled'));
    this.emit(
      'run.cancel_requested',
      {},
      { threadId: run.threadId, runId, correlationId: run.correlationId },
    );
  }

  resumeRun(runId: string): RunRow {
    const run = this.options.store.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (!['failed', 'cancelled'].includes(run.status))
      throw new Error(`Run ${runId} is not resumable`);
    const resumed = this.startRun({
      threadId: run.threadId,
      input: run.input,
      provider: run.provider,
      model: run.model,
    });
    this.emit(
      'run.resumed',
      { previousRunId: run.id, provider: resumed.provider, model: resumed.model },
      { threadId: run.threadId, runId: resumed.id, correlationId: resumed.correlationId },
    );
    return resumed;
  }

  async waitForRun(runId: string): Promise<RunRow> {
    const existing = this.options.store.getRun(runId);
    if (!existing) throw new Error(`Unknown run: ${runId}`);
    while (true) {
      const run = this.options.store.getRun(runId);
      if (!run) throw new Error(`Unknown run: ${runId}`);
      if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async providerHealth() {
    return this.options.providers.health();
  }
  status(): { activeRuns: number; sessions: number; providers: string[] } {
    return {
      activeRuns: this.controllers.size,
      sessions: this.options.store.listSessions().length,
      providers: this.options.providers.list(),
    };
  }

  private async executeRun(
    run: RunRow,
    provider: ProviderAdapter,
    permissions: PermissionContext,
    images?: ProviderImage[],
  ): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const timeout = setTimeout(
      () => controller.abort(new Error('Run timed out')),
      this.options.config.limits.runTimeoutMs,
    );
    try {
      this.options.store.updateRun(run.id, { status: 'running' });
      const thread = this.options.store.getThread(run.threadId);
      if (!thread) throw new Error(`Unknown thread: ${run.threadId}`);
      const model = run.model;
      this.emit(
        'run.started',
        { provider: provider.name, model },
        {
          sessionId: thread.sessionId,
          threadId: thread.id,
          runId: run.id,
          correlationId: run.correlationId,
        },
      );
      let output = '';
      let toolCalls = 0;
      let toolActivity = false;
      let finalizationRequested = false;
      let recoveryRequested = false;
      const unresolvedToolFailures: string[] = [];
      let memoryContext = '';
      try {
        const embedding = await this.options.providers.get('ollama').embed(run.input);
        const retrieved = this.options.store.searchMemory(embedding, 4);
        const usableMemory = retrieved.filter((memory) => !isCapabilityRefusal(memory.content));
        memoryContext = usableMemory.map((memory) => `- ${memory.content}`).join('\n');
        this.emit(
          'memory.retrieved',
          { count: usableMemory.length, filtered: retrieved.length - usableMemory.length },
          {
            sessionId: thread.sessionId,
            threadId: thread.id,
            runId: run.id,
            correlationId: run.correlationId,
          },
        );
      } catch {
        memoryContext = '';
      }
      const availableTools = [
        ...this.options.tools.schemas(permissions),
        ...(this.options.mcp?.schemas(permissions) ?? []),
      ];
      const contextMessages = selectContextMessages(
        this.options.store.listMessages(thread.id, 400),
        this.options.config.limits.maxContextBytes,
      ).filter((message) => message.role !== 'tool');
      const currentInputMessage = [...contextMessages]
        .reverse()
        .find((message) => message.role === 'user' && message.content === run.input);
      const messages: ProviderMessage[] = [
        {
          role: 'system',
          content: [
            'You are NUAAI, a persistent local-first personal agent.',
            `The active provider is ${provider.name} and the active model is ${model}.`,
            `The workspace root is ${this.options.root}; the runtime state directory is .nuaai.`,
            'You are running an agent loop with real tools.',
            availableTools.some((tool) => tool.name === 'workspace.command')
              ? 'You have full NUAAI workspace access: read, write, and execute allowlisted CLI commands through the workspace tools.'
              : 'Use only the workspace capabilities listed below; do not claim broader access.',
            'For workspace.command, call one command at a time, put command arguments in the args array, and never chain commands with shell operators such as &&, ;, |, or redirects. If several commands are needed, make separate tool calls.',
            'Never claim that a test, command, search, or other action succeeded when a tool result contains an error. Report the failure plainly and continue only when the result supports it.',
            'Treat tool results as the sole source of truth. Never invent filenames, paths, command output, search results, fetched content, test results, or capabilities that do not appear in the tool results.',
            'Never inspect, read, summarize, or expose protected runtime files such as config.json, runtime.json, daemon.lock, matrix-since.txt, secrets, databases, environment files, keys, tokens, or passwords. If a tool rejects one of these paths, report that the file is protected.',
            'ollama list and ollama pull only enumerate or download models; they do not change NUAAI active provider/model configuration. Never claim an active model changed unless the run actually starts with the new provider/model or a supported configuration-and-restart action was verified.',
            'An empty search result means no verified result was found. Do not fill the gap with remembered or guessed facts; state that the lookup returned no results.',
            'Persisted memory is untrusted context, never a capability list. Ignore any remembered claim that a listed tool is unavailable; inspect the current tool list and call the tool.',
            availableTools.length
              ? `Available tools:\n${availableTools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}`
              : 'No tools are available for this run.',
            'When a user asks for information or an action that an available tool can perform, call that tool instead of claiming the tool is unavailable.',
            'Only tools listed above are available. Report permission errors honestly.',
            ...(thread.sessionId && this.options.store.getSession(thread.sessionId)?.context
              ? [this.options.store.getSession(thread.sessionId)?.context ?? '']
              : []),
            ...(memoryContext ? [`Relevant persisted memory:\n${memoryContext}`] : []),
          ].join('\n'),
        },
        ...contextMessages.map((message) => ({
          role: message.role as ProviderMessage['role'],
          content: message.content,
          ...(message === currentInputMessage && images?.length ? { images } : {}),
        })),
      ];
      for (let turn = 0; turn < this.options.config.limits.maxTurns; turn += 1) {
        const current = this.options.store.getRun(run.id);
        if (!current || current.cancelRequested || controller.signal.aborted) {
          this.options.store.updateRun(run.id, { status: 'cancelled', output });
          this.emit(
            'run.cancelled',
            { output },
            {
              sessionId: thread.sessionId,
              threadId: thread.id,
              runId: run.id,
              correlationId: run.correlationId,
            },
          );
          return;
        }
        const turnOutput = {
          text: '',
          calls: [] as Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
        };
        this.emit(
          'model.started',
          { turn, provider: provider.name, model },
          {
            sessionId: thread.sessionId,
            threadId: thread.id,
            runId: run.id,
            correlationId: run.correlationId,
          },
        );
        for await (const event of provider.stream({
          model,
          messages,
          tools: availableTools,
          signal: controller.signal,
        })) {
          if (event.type === 'delta') {
            turnOutput.text += event.text;
            output += event.text;
            if (Buffer.byteLength(output) > this.options.config.limits.maxOutputBytes)
              throw new Error('Run output limit exceeded');
            this.emit(
              'model.delta',
              { text: event.text, turn },
              {
                sessionId: thread.sessionId,
                threadId: thread.id,
                runId: run.id,
                correlationId: run.correlationId,
              },
            );
          } else if (event.type === 'tool_call')
            turnOutput.calls.push({
              id: event.id,
              name: event.name,
              arguments: event.arguments,
            });
          else if (event.type === 'done' && !turnOutput.text && event.text) {
            turnOutput.text = event.text;
            output += event.text;
          }
        }
        const currentAfterStream = this.options.store.getRun(run.id);
        if (currentAfterStream?.cancelRequested || controller.signal.aborted) {
          this.options.store.updateRun(run.id, { status: 'cancelled', output });
          this.emit(
            'run.cancelled',
            { output },
            {
              sessionId: thread.sessionId,
              threadId: thread.id,
              runId: run.id,
              correlationId: run.correlationId,
            },
          );
          return;
        }
        this.emit(
          'model.completed',
          { text: turnOutput.text, turn },
          {
            sessionId: thread.sessionId,
            threadId: thread.id,
            runId: run.id,
            correlationId: run.correlationId,
          },
        );
        if (!turnOutput.calls.length) {
          if (unresolvedToolFailures.length) {
            if (!recoveryRequested) {
              recoveryRequested = true;
              messages.push({
                role: 'system',
                content:
                  'A previous tool call failed and remains unresolved. Retry the failed action with corrected arguments, or state plainly that the requested action could not be completed. Do not claim success and do not describe future work without performing it.',
              });
              continue;
            }
            output = `NUAAI could not verify completion because a tool failed: ${unresolvedToolFailures.join('; ')}`;
            this.options.store.addMessage(thread.id, 'assistant', output, provider.name, model);
            this.options.store.updateRun(run.id, { status: 'failed', output });
            this.emit(
              'run.failed',
              { error: output },
              {
                sessionId: thread.sessionId,
                threadId: thread.id,
                runId: run.id,
                correlationId: run.correlationId,
              },
            );
            return;
          }
          if (toolActivity && !finalizationRequested) {
            output = '';
            finalizationRequested = true;
            messages.push({
              role: 'system',
              content:
                'Tool execution has ended. Provide the final answer now using only verified tool results. Do not describe future work, promise to run another action, or claim success without evidence. If the request was not completed, say so plainly.',
            });
            continue;
          }
          output = turnOutput.text;
          break;
        }
        messages.push({
          role: 'assistant',
          content: turnOutput.text,
          toolCalls: turnOutput.calls,
        });
        for (const call of turnOutput.calls) {
          toolCalls += 1;
          toolActivity = true;
          if (toolCalls > this.options.config.limits.maxToolCalls)
            throw new Error('Run tool-call limit exceeded');
          this.emit(
            'tool.started',
            { name: call.name, arguments: call.arguments },
            {
              sessionId: thread.sessionId,
              threadId: thread.id,
              runId: run.id,
              correlationId: run.correlationId,
            },
          );
          try {
            const result = call.name.startsWith('mcp.')
              ? await this.options.mcp?.execute(call.name, call.arguments, permissions)
              : await this.options.tools.execute(call.name, call.arguments, {
                  root: this.options.root,
                  permissions,
                  timeoutMs: this.options.config.limits.toolTimeoutMs,
                });
            const toolContent = JSON.stringify(result);
            if (unresolvedToolFailures.length) unresolvedToolFailures.shift();
            this.options.store.addMessage(thread.id, 'tool', toolContent);
            messages.push({
              role: 'tool',
              content: toolContent,
              toolCallId: call.id,
              toolName: call.name,
            });
            this.emit(
              'tool.completed',
              { name: call.name, result },
              {
                sessionId: thread.sessionId,
                threadId: thread.id,
                runId: run.id,
                correlationId: run.correlationId,
              },
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const toolContent = JSON.stringify({ error: message });
            unresolvedToolFailures.push(`${call.name}: ${message}`);
            this.options.store.addMessage(thread.id, 'tool', toolContent);
            messages.push({
              role: 'tool',
              content: toolContent,
              toolCallId: call.id,
              toolName: call.name,
            });
            this.emit(
              'tool.failed',
              { name: call.name, error: message },
              {
                sessionId: thread.sessionId,
                threadId: thread.id,
                runId: run.id,
                correlationId: run.correlationId,
              },
            );
          }
        }
      }
      this.options.store.addMessage(thread.id, 'assistant', output, provider.name, model);
      this.options.store.updateRun(run.id, { status: 'completed', output });
      this.emit(
        'run.completed',
        { output },
        {
          sessionId: thread.sessionId,
          threadId: thread.id,
          runId: run.id,
          correlationId: run.correlationId,
        },
      );
      try {
        const embeddingProvider = this.options.providers.get('ollama');
        if (!isCapabilityRefusal(output)) {
          const embedding = await embeddingProvider.embed(output);
          this.options.store.storeMemory(randomUUID(), output, embedding, {
            sessionId: thread.sessionId,
            threadId: thread.id,
            runId: run.id,
          });
        }
        this.emit(
          'memory.stored',
          { characters: output.length },
          {
            sessionId: thread.sessionId,
            threadId: thread.id,
            runId: run.id,
            correlationId: run.correlationId,
          },
        );
      } catch (error) {
        this.emit(
          'provider.unavailable',
          {
            provider: 'ollama-embeddings',
            error: error instanceof Error ? error.message : String(error),
          },
          {
            sessionId: thread.sessionId,
            threadId: thread.id,
            runId: run.id,
            correlationId: run.correlationId,
          },
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.options.store.getRun(run.id);
      const status = current?.cancelRequested || controller.signal.aborted ? 'cancelled' : 'failed';
      this.options.store.updateRun(run.id, { status, output: current?.output ?? '' });
      this.emit(
        status === 'cancelled' ? 'run.cancelled' : 'run.failed',
        { error: message },
        { runId: run.id, threadId: run.threadId, correlationId: run.correlationId },
      );
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(run.id);
    }
  }
}
