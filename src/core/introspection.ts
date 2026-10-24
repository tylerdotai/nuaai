import { resolve } from 'node:path';
import { z } from 'zod';
import type { DatabaseStore } from '../memory/db.js';
import { redactValue } from '../security/redaction.js';
import type { ToolContext, ToolRegistry } from '../tools/registry.js';
import type { AgentRuntime } from './runtime.js';

export function registerRuntimeIntrospection(
  tools: ToolRegistry,
  store: DatabaseStore,
  contextStatus: () => ReturnType<AgentRuntime['status']>['context'],
  learningStatus: () => { available: boolean; enabled: boolean },
  executionStatus: (runId: string) => ReturnType<AgentRuntime['executionStatus']>,
): () => void {
  const input = z
    .object({
      section: z
        .enum(['overview', 'capabilities', 'context', 'learning', 'observations', 'observation'])
        .default('overview'),
      callId: z.string().min(1).max(256).optional(),
      offsetEntries: z.number().int().min(0).default(0),
      limitEntries: z.number().int().min(1).max(20).default(10),
      offsetCharacters: z.number().int().min(0).default(0),
      limitCharacters: z.number().int().min(1).max(2048).default(1024),
      requestApproval: z.boolean().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.section === 'observation' && !value.callId)
        context.addIssue({ code: 'custom', message: 'observation requires the recorded callId' });
    });
  const boundRun = (context: ToolContext) => {
    const run = context.runId ? store.getRun(context.runId) : undefined;
    if (!run || run.threadId !== context.threadId)
      throw new Error('Runtime inspection requires a matching run/thread binding');
    const thread = store.getThread(run.threadId);
    const pinned = store.getRunExecutionContext(run.id)?.identitySnapshotId;
    const identity =
      thread && pinned ? store.getSessionIdentity(thread.sessionId, pinned) : undefined;
    if (!identity || resolve(identity.workspaceRoot) !== resolve(context.root))
      throw new Error('Runtime inspection workspace binding is unavailable or mismatched');
    return { run, thread, identity };
  };
  return tools.register({
    name: 'runtime.inspect',
    permission: 'read',
    description:
      'Inspect this bound run: actual registered capabilities, permissions, approval mode, context estimates/checkpoints and recorded failures/learning events. Retrieve archived tool observations by exact callId in bounded Unicode-character chunks. Cannot target another run or change configuration, tools or permissions.',
    governance: {
      owner: 'runtime',
      costClass: 'low',
      authMode: 'none',
      sideEffects: 'none',
      approval: 'none',
      maxCallsPerRun: 48,
    },
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['overview', 'capabilities', 'context', 'learning', 'observations', 'observation'],
        },
        callId: {
          type: 'string',
          description: 'Exact recorded tool call ID; required for observation',
        },
        offsetEntries: { type: 'integer', minimum: 0 },
        limitEntries: { type: 'integer', minimum: 1, maximum: 20 },
        offsetCharacters: { type: 'integer', minimum: 0 },
        limitCharacters: { type: 'integer', minimum: 1, maximum: 2048 },
      },
    },
    input,
    authorize: (_input, context) => {
      boundRun(context);
    },
    execute: async (raw, context) => {
      const query = raw as z.infer<typeof input>;
      const { run, thread } = boundRun(context);
      if (!thread) throw new Error('Runtime inspection thread binding is unavailable');
      if (query.section === 'observations')
        return store.listRunObservations(run.id, query.offsetEntries, query.limitEntries);
      if (query.section === 'observation') {
        const value = store.readRunObservation(
          run.id,
          query.callId ?? '',
          query.offsetCharacters,
          query.limitCharacters,
        );
        if (!value) throw new Error('Archived observation not found in this bound run');
        return value;
      }
      const recent = store.listRecentEventsForRun(run.id, 200);
      const selection = store.latestEventForRun(run.id, 'context.selected');
      const checkpoint = store.latestEventForRun(run.id, 'context.compacted');
      const failure = [
        store.latestEventForRun(run.id, 'tool.failed'),
        store.latestEventForRun(run.id, 'run.failed'),
      ]
        .filter((event) => event !== undefined)
        .sort((a, b) => b.id - a.id)[0];
      const policy = store.sessionApprovalPolicy(thread.sessionId);
      const limits = contextStatus();
      const snapshot = {
        scope: 'bound_run',
        execution: executionStatus(run.id),
        run: {
          id: run.id,
          threadId: run.threadId,
          status: run.status,
          provider: run.provider,
          model: run.model,
          cancelRequested: run.cancelRequested,
          correlationId: run.correlationId,
        },
        capabilities: {
          tools: tools.schemas(context.permissions).map((tool) => tool.name),
          permissions: [...context.permissions.approved],
          boundaries: context.permissions.capabilities,
          approvalMode: policy.mode,
          meaning:
            'Registered tools accessible to the bound caller permission context; action approvals and target-specific availability still apply.',
        },
        context: {
          estimator: limits.estimator,
          maxContextUnits:
            typeof selection?.payload.maxContextUnits === 'number'
              ? selection.payload.maxContextUnits
              : limits.maxTokens,
          responseReserveUnits: limits.responseReserveTokens,
          maxSummaryUnits: limits.maxSummaryTokens,
          estimated: true,
          selection: selection
            ? {
                phase: selection.payload.phase,
                estimatedContextUnits: selection.payload.estimatedContextUnits,
                maxContextUnits: selection.payload.maxContextUnits,
                responseReserveUnits: limits.responseReserveTokens,
                selectedMessageCount: selection.payload.selectedMessageCount,
                estimated: true,
              }
            : null,
          latestCheckpoint: checkpoint?.payload ?? null,
        },
        learning: {
          automatic: learningStatus(),
          recentEvents: recent
            .filter((event) => /^(?:knowledge|memory|skill)\./u.test(event.type))
            .slice(-5)
            .map((event) => ({
              id: event.id,
              type: event.type,
              saved: event.payload.saved ?? null,
              proposed: event.payload.proposed ?? null,
              rejectedReasons: event.payload.rejectedReasons ?? null,
              taskId: event.payload.taskId ?? null,
              error:
                typeof event.payload.error === 'string'
                  ? redactValue(event.payload.error.slice(0, 500))
                  : null,
            })),
        },
        lastFailure: failure
          ? {
              eventId: failure.id,
              type: failure.type,
              details: redactValue({
                tool: failure.payload.name ?? null,
                error:
                  typeof failure.payload.error === 'string'
                    ? failure.payload.error.slice(0, 1000)
                    : null,
              }),
              failureCode:
                typeof failure.payload.failureCode === 'string'
                  ? failure.payload.failureCode
                  : null,
              executionState: failure.payload.executionState ?? 'unknown',
              recovery: failure.payload.recovery ?? 'unknown',
              retrySafety:
                failure.payload.executionState === 'uncertain'
                  ? 'do_not_retry_automatically'
                  : failure.payload.executionState === 'not_executed'
                    ? 'follow_recorded_recovery_not_blind_repetition'
                    : 'unknown',
            }
          : null,
      };
      if (query.section === 'capabilities') return snapshot.capabilities;
      if (query.section === 'context') return snapshot.context;
      if (query.section === 'learning') return snapshot.learning;
      return snapshot;
    },
  });
}
