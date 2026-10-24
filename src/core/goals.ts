import type { RuntimeConfig } from '../config/index.js';
import type { DatabaseStore, GoalRow, RunRow, TaskRow } from '../memory/db.js';
import { executionPolicy } from './execution-policy.js';
import type { AgentRuntime, RunRequest } from './runtime.js';
import type { Scheduler } from './scheduler.js';

const terminalGoals = new Set(['completed', 'blocked', 'cancelled', 'superseded']);

/** Goal ownership schedules native runs; it never executes tools or bypasses their authority. */
export class GoalCoordinator {
  private stopping = false;
  constructor(
    private readonly store: DatabaseStore,
    private readonly runtime: AgentRuntime,
    private readonly scheduler: Scheduler,
    private readonly config: RuntimeConfig,
  ) {
    scheduler.registerInternalHandler('goal.continue', async (task, signal) => {
      signal.throwIfAborted();
      if (this.stopping) throw new Error('Daemon stopping before goal continuation admission');
      const goal = store.getGoal(String(task.payload.goalId));
      if (!goal || goal.status !== 'queued' || goal.currentRunId !== task.payload.sourceRunId)
        return;
      if (!this.withinBudget(goal)) return;
      runtime.continueGoalRun(
        goal.currentRunId,
        goal.id,
        `goal:${goal.id}:slice:${goal.sliceCount + 1}`,
      );
    });
  }

  stop(): void {
    this.stopping = true;
    for (const goal of this.store.listGoals()) {
      if (
        goal.status === 'running' &&
        ['queued', 'running', 'paused'].includes(this.store.getRun(goal.currentRunId)?.status ?? '')
      ) {
        goal.status = 'blocked';
        goal.checkpoint.reason =
          'Daemon interrupted this slice; effects require inspection before another admission';
        this.save(goal);
      }
    }
  }

  admit(run: RunRow, request: RunRequest): void {
    if (this.stopping) throw new Error('Goal owner is stopping');
    const context = this.store.getRunExecutionContext(run.id);
    if (!context) throw new Error('Goal admission requires retained execution authority');
    if (request.goalId) {
      const goal = this.store.getGoal(request.goalId);
      if (
        !goal ||
        goal.status !== 'queued' ||
        goal.threadId !== run.threadId ||
        goal.currentRunId !== request.continuationOf
      )
        throw new Error('Goal continuation is no longer eligible');
      this.reserveFamilyAdmission(goal);
      goal.currentRunId = run.id;
      goal.sliceCount += 1;
      goal.status = 'running';
      goal.checkpoint.runIds.push(run.id);
      this.save(goal);
      this.store.saveRunExecutionContext(run.id, {
        ...context,
        goalId: goal.id,
        continuationOf: request.continuationOf,
      });
      return;
    }
    for (const previous of this.store.listGoals(run.threadId)) {
      if (terminalGoals.has(previous.status)) continue;
      previous.status = 'superseded';
      previous.checkpoint.reason = 'New user/work admission superseded automatic continuation';
      this.save(previous);
      if (this.store.getRunExecutionContext(previous.currentRunId)?.continuationOf)
        this.runtime.cancelRun(previous.currentRunId);
    }
    const now = Date.now();
    const parentGoalId = request.parentRunId
      ? this.store.getRunExecutionContext(request.parentRunId)?.goalId
      : undefined;
    const parentGoal = parentGoalId ? this.store.getGoal(parentGoalId) : undefined;
    if (request.parentRunId && !parentGoal)
      throw new Error('Owned child goal parent is unavailable');
    const policy =
      parentGoal?.checkpoint.policy ?? executionPolicy(request.execution, this.config.limits);
    const deadlineAt =
      parentGoal?.checkpoint.deadlineAt ?? new Date(now + policy.durationMs).toISOString();
    const goal: GoalRow = {
      id: run.id,
      threadId: run.threadId,
      rootRunId: run.id,
      currentRunId: run.id,
      status: 'running',
      sliceCount: 1,
      checkpoint: {
        runIds: [run.id],
        consumedTaskIds: [],
        policy,
        deadlineAt,
        familyRootId: parentGoal?.checkpoint.familyRootId ?? parentGoal?.id ?? run.id,
        ...(parentGoal ? {} : { familyAdmissions: 0, familyBudget: policy.maxRuns }),
      },
      createdAt: now,
      updatedAt: now,
    };
    this.reserveFamilyAdmission(goal);
    this.store.saveGoal(goal);
    this.store.saveRunExecutionContext(run.id, { ...context, goalId: run.id });
  }

  cancel(runId: string): void {
    const goalId = this.store.getRunExecutionContext(runId)?.goalId;
    const goal = goalId && this.store.getGoal(goalId);
    if (!goal || terminalGoals.has(goal.status)) return;
    goal.status = 'cancelled';
    goal.checkpoint.reason = 'Cancelled by the owner';
    this.save(goal);
    for (const child of this.store.tasksForRuns(goal.checkpoint.runIds))
      if (['queued', 'running'].includes(child.status)) this.scheduler.cancelTask(child.id);
    if (
      goal.currentRunId !== runId &&
      ['queued', 'running', 'paused'].includes(this.store.getRun(goal.currentRunId)?.status ?? '')
    )
      this.runtime.cancelRun(goal.currentRunId);
  }

  observeRun(runId: string): void {
    const goalId = this.store.getRunExecutionContext(runId)?.goalId;
    const goal = goalId && this.store.getGoal(goalId);
    if (
      !goal ||
      goal.currentRunId !== runId ||
      terminalGoals.has(goal.status) ||
      goal.status === 'queued'
    )
      return;
    const run = this.store.getRun(runId);
    if (!run || ['queued', 'running', 'paused'].includes(run.status)) return;
    if (run.status !== 'completed') {
      goal.status = run.status === 'cancelled' ? 'cancelled' : 'blocked';
      goal.checkpoint.reason = run.output || `Run ${run.status}`;
      this.save(goal);
      return;
    }
    const children = this.store.tasksForRuns(goal.checkpoint.runIds);
    if (children.some((task) => ['queued', 'running'].includes(task.status))) {
      goal.status = 'waiting';
      goal.checkpoint.reason = 'Waiting for owned background outcomes';
      this.save(goal);
      return;
    }
    if (children.some((task) => task.status !== 'completed')) {
      goal.status = 'blocked';
      goal.checkpoint.reason =
        'An owned background task failed or was cancelled; its actual outcome was delivered';
      this.save(goal);
      return;
    }
    const fresh = children.filter((task) => !goal.checkpoint.consumedTaskIds.includes(task.id));
    if (fresh.length) {
      if (fresh.some((task) => !task.payload.parentDelivery)) return;
      if (!this.withinBudget(goal)) return;
      goal.checkpoint.consumedTaskIds.push(...fresh.map((task) => task.id));
      goal.status = 'queued';
      goal.checkpoint.reason = 'Verified owned child outcomes are available';
      this.save(goal);
      if (!this.store.taskForSource('goal.continue', runId))
        this.store.createTask('goal.continue', {
          internal: true,
          sourceRunId: runId,
          goalId: goal.id,
          attempts: 0,
        });
      this.scheduler.wake();
      return;
    }
    goal.status = 'completed';
    goal.checkpoint.reason = 'Verified native slice completed with no outstanding owned work';
    this.save(goal);
  }

  observeTask(task: TaskRow): void {
    if (typeof task.payload.parentRunId === 'string') {
      const goalId = this.store.getRunExecutionContext(task.payload.parentRunId)?.goalId;
      const goal = goalId && this.store.getGoal(goalId);
      if (goal) this.observeRun(goal.currentRunId);
    }
  }

  recover(): void {
    for (const goal of this.store.listGoals())
      if (!terminalGoals.has(goal.status)) this.observeRun(goal.currentRunId);
  }

  private reserveFamilyAdmission(goal: GoalRow): void {
    const rootId = goal.checkpoint.familyRootId ?? goal.id;
    const family = rootId === goal.id ? goal : this.store.getGoal(rootId);
    if (!family) throw new Error('Goal family ownership is unavailable');
    const used = family.checkpoint.familyAdmissions ?? family.checkpoint.runIds.length;
    const limit = family.checkpoint.familyBudget ?? this.config.limits.maxGoalFamilyRuns;
    if (
      ['blocked', 'cancelled'].includes(family.status) ||
      used >= limit ||
      (family.checkpoint.deadlineAt && Date.now() >= Date.parse(family.checkpoint.deadlineAt))
    )
      throw new Error(
        'Goal family admission budget exhausted or ownership retired; no model request was started',
      );
    family.checkpoint.familyAdmissions = used + 1;
    family.checkpoint.familyBudget = limit;
    this.save(family);
  }

  private withinBudget(goal: GoalRow): boolean {
    const policy = goal.checkpoint.policy ?? executionPolicy(undefined, this.config.limits);
    const deadline = goal.checkpoint.deadlineAt
      ? Date.parse(goal.checkpoint.deadlineAt)
      : goal.createdAt + policy.durationMs;
    const family = this.store.getGoal(goal.checkpoint.familyRootId ?? goal.id);
    const available =
      family &&
      !['blocked', 'cancelled'].includes(family.status) &&
      (family.checkpoint.familyAdmissions ?? family.checkpoint.runIds.length) <
        (family.checkpoint.familyBudget ?? policy.maxRuns);
    if (available && goal.sliceCount < policy.maxSlices && Date.now() < deadline) return true;
    goal.status = 'blocked';
    goal.checkpoint.reason =
      'Automatic continuation budget exhausted; no further slice was admitted';
    this.save(goal);
    return false;
  }

  private save(goal: GoalRow): void {
    goal.updatedAt = Date.now();
    this.store.saveGoal(goal);
  }
}
