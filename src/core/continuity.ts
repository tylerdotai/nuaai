import type { RuntimeConfig } from '../config/index.js';
import type { DatabaseStore, RunRow, TaskRow } from '../memory/db.js';
import { redactText } from '../security/redaction.js';
import { GoalCoordinator } from './goals.js';
import type { AgentRuntime, RunRequest } from './runtime.js';
import type { Scheduler } from './scheduler.js';

/** Durable parent delivery consumes the existing runtime/scheduler event stream. */
export class ContinuityCoordinator {
  private readonly unsubscribe: () => void;
  private readonly goals: GoalCoordinator;

  constructor(
    private readonly store: DatabaseStore,
    private readonly runtime: AgentRuntime,
    scheduler: Scheduler,
    config: RuntimeConfig,
  ) {
    this.goals = new GoalCoordinator(store, runtime, scheduler, config);
    this.unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'run.cancel_requested' && event.runId) {
        this.goals.cancel(event.runId);
        return;
      }
      if (
        ['task.completed', 'task.failed', 'task.cancelled'].includes(event.type) &&
        event.taskId
      ) {
        const task = store.getTask(event.taskId);
        if (typeof task?.payload.parentRunId === 'string') this.recover(task.payload.parentRunId);
        if (task) this.goals.observeTask(task);
      } else if (
        ['run.completed', 'run.failed', 'run.cancelled', 'run.paused'].includes(event.type) &&
        event.runId
      ) {
        this.recover(event.runId);
        this.goals.observeRun(event.runId);
      }
    });
  }

  admit(run: RunRow, request: RunRequest): void {
    this.goals.admit(run, request);
  }

  close(): void {
    this.goals.stop();
    this.unsubscribe();
  }

  recover(parentRunId?: string): void {
    for (;;) {
      const pending = this.store.pendingTaskDeliveries(parentRunId);
      let delivered = 0;
      for (const task of pending) {
        try {
          if (this.deliver(task)) delivered += 1;
        } catch (error) {
          this.runtime.publishEvent(
            'task.result.failed',
            {
              error: redactText(error instanceof Error ? error.message : String(error)),
              phase: 'parent_delivery',
            },
            { taskId: task.id },
          );
        }
      }
      if (pending.length < 200 || delivered === 0) break;
    }
    if (!parentRunId) this.goals.recover();
  }

  private deliver(task: TaskRow): boolean {
    const result = this.store.transaction(() => {
      const current = this.store.getTask(task.id);
      if (
        !current ||
        current.payload.parentDelivery ||
        !['completed', 'failed', 'cancelled'].includes(current.status)
      )
        return;
      const parentId = String(current.payload.parentRunId);
      const parent = this.store.getRun(parentId);
      const thread = parent && this.store.getThread(parent.threadId);
      const authority = parent && this.store.getRunExecutionContext(parent.id);
      const identity =
        thread &&
        authority?.identitySnapshotId &&
        this.store.getSessionIdentity(thread.sessionId, authority.identitySnapshotId);
      if (!parent || !thread || !identity || ['queued', 'running'].includes(parent.status)) return;
      const execution = current.payload.execution as Record<string, unknown> | undefined;
      const child =
        typeof execution?.runId === 'string' ? this.store.getRun(execution.runId) : undefined;
      if (child) {
        const childThread = this.store.getThread(child.threadId);
        const childContext = this.store.getRunExecutionContext(child.id);
        const childIdentity =
          childThread &&
          childContext?.identitySnapshotId &&
          this.store.getSessionIdentity(childThread.sessionId, childContext.identitySnapshotId);
        if (
          !childIdentity ||
          childIdentity.workspaceRoot !== identity.workspaceRoot ||
          childIdentity.inheritedFrom?.sessionId !== thread.sessionId
        )
          throw new Error('Child result does not match the bound parent identity and workspace.');
      }
      const artifacts = child
        ? this.store.listRunArtifacts(child.id).map((artifact) => ({
            id: artifact.id,
            runId: artifact.runId,
            title: artifact.title,
            byteSize: artifact.byteSize,
            sha256: artifact.sha256,
          }))
        : [];
      const detail =
        child?.output ||
        (typeof current.payload.error === 'string'
          ? current.payload.error
          : 'No final child output was recorded.');
      const content = `Background task ${current.id} ${current.status}.\n\n${child && child.status !== 'completed' ? 'Incomplete child output / recorded failure:\n' : ''}${redactText(detail).slice(0, 6000)}${artifacts.length ? `\n\nRecorded artifacts (not proof of task success):\n${artifacts.map((artifact) => `${redactText(artifact.title)} — ${artifact.byteSize} bytes — ${artifact.id}`).join('\n')}` : ''}`;
      const message = this.store.addMessage(thread.id, 'assistant', content);
      this.store.storeMessageArtifact(message.id, 'task_result', {
        taskId: current.id,
        parentRunId: parent.id,
        childRunId: child?.id ?? null,
        status: current.status,
        artifacts,
      });
      this.store.updateTask(current.id, current.status, {
        ...current.payload,
        parentDelivery: { messageId: message.id, at: message.createdAt },
      });
      return { message, parent };
    });
    if (!result) return false;
    this.runtime.publishEvent(
      'message.created',
      { role: 'assistant', messageId: result.message.id, kind: 'task_result' },
      { threadId: result.parent.threadId },
    );
    this.runtime.publishEvent(
      'task.result.delivered',
      { messageId: result.message.id },
      {
        taskId: task.id,
        threadId: result.parent.threadId,
        runId: result.parent.id,
        correlationId: result.parent.correlationId,
      },
    );
    return true;
  }
}
