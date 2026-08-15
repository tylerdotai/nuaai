import { randomUUID } from 'node:crypto';

import type { RuntimeConfig } from '../config/index.js';
import type { DatabaseStore, RunRow, SessionRow, ThreadRow } from '../memory/db.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderAdapter, ProviderMessage } from '../providers/types.js';
import type { PermissionContext } from '../security/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { type EventRecord, createEvent } from './events.js';

export interface RuntimeOptions {
  root: string;
  config: RuntimeConfig;
  store: DatabaseStore;
  providers: ProviderRegistry;
  tools: ToolRegistry;
}
export interface RunRequest {
  threadId: string;
  input: string;
  provider?: string;
  model?: string;
  permissions?: PermissionContext;
}
export type RuntimeListener = (event: EventRecord & { id: number }) => void;

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
          approved: new Set(['read']),
          capabilities: { filesystem: true, network: true },
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

  createSession(title?: string): { session: SessionRow; thread: ThreadRow } {
    const created = this.options.store.createSession(title);
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
        approved: new Set(['read']),
        capabilities: { filesystem: true, network: true },
      },
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
      let memoryContext = '';
      try {
        const embedding = await this.options.providers.get('ollama').embed(run.input);
        const retrieved = this.options.store.searchMemory(embedding, 4);
        memoryContext = retrieved.map((memory) => `- ${memory.content}`).join('\n');
        this.emit(
          'memory.retrieved',
          { count: retrieved.length },
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
      const availableTools = this.options.tools.schemas(permissions);
      const messages: ProviderMessage[] = [
        {
          role: 'system',
          content: [
            'You are NUAAI, a persistent local-first personal agent.',
            `The active provider is ${provider.name} and the active model is ${model}.`,
            'You are running an agent loop with real tools.',
            availableTools.length
              ? `Available tools:\n${availableTools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}`
              : 'No tools are available for this run.',
            'When a user asks for information or an action that an available tool can perform, call that tool instead of claiming the tool is unavailable.',
            'Only tools listed above are available. Report permission errors honestly.',
            ...(memoryContext ? [`Relevant persisted memory:\n${memoryContext}`] : []),
          ].join('\n'),
        },
        ...this.options.store
          .listMessages(thread.id, 200)
          .filter((message) => message.role !== 'tool')
          .map((message) => ({
            role: message.role as ProviderMessage['role'],
            content: message.content,
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
        if (!turnOutput.calls.length) break;
        messages.push({
          role: 'assistant',
          content: turnOutput.text,
          toolCalls: turnOutput.calls,
        });
        for (const call of turnOutput.calls) {
          toolCalls += 1;
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
            const result = await this.options.tools.execute(call.name, call.arguments, {
              root: this.options.root,
              permissions,
              timeoutMs: this.options.config.limits.toolTimeoutMs,
            });
            const toolContent = JSON.stringify(result);
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
        const embedding = await embeddingProvider.embed(output);
        this.options.store.storeMemory(randomUUID(), output, embedding, {
          sessionId: thread.sessionId,
          threadId: thread.id,
          runId: run.id,
        });
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
