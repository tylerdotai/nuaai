import { createHash, randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import { redactText } from '../security/redaction.js';
import { abortableStream } from './async.js';
import {
  type ExecutionRequest,
  MAX_GOAL_DURATION_MS,
  MAX_GOAL_RUNS,
  executionPolicy,
  executionRequestSchema,
} from './execution-policy.js';

import type { RunArtifactCandidate, RunArtifactRegistry } from '../artifacts/registry.js';
import type { RuntimeConfig } from '../config/index.js';
import type { McpManager } from '../integrations/mcp.js';
import type { DatabaseStore, MessageRow, RunRow, SessionRow, ThreadRow } from '../memory/db.js';
import type { KnowledgeLearner } from '../memory/learning.js';
import { memoryVisibleInWorkspace } from '../memory/scope.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { canonicalProviderMessages } from '../providers/request.js';
import type {
  ProviderAdapter,
  ProviderDynamicTool,
  ProviderDynamicToolCallMetadata,
  ProviderImage,
  ProviderMessage,
} from '../providers/types.js';
import { type PermissionContext, permissionContextForProfile } from '../security/permissions.js';
import type { SkillLearner } from '../skills/learner.js';
import type { SkillRegistry } from '../skills/registry.js';
import {
  type ToolBudget,
  ToolBudgetError,
  type ToolDescription,
  type ToolRegistry,
  createToolBudget,
} from '../tools/registry.js';
import { assertSafeProjectFile } from '../workspace/fs.js';
import {
  ApprovalDeniedError,
  ApprovalExpiredError,
  type ApprovalPreviewV1,
  type ApprovalRequestRow,
  type ApprovalRequestView,
  ApprovalStateError,
  type ApprovalStatus,
  approvalPayloadHash,
  approvalTarget,
  buildTransientApprovalPreview,
  canonicalizeApprovalArguments,
  publicApprovalRequest,
} from './approvals.js';
import {
  type VerificationObservation,
  buildCapabilityManifest,
  classifyVerificationPolicy,
  hasRelevantVerificationEvidence,
  isCapabilityRefusal,
  requestDisablesTools,
  verificationRequiresEvidence,
} from './capabilities.js';
import { ContextBufferManager } from './context-buffer.js';
import {
  assertRequestContextBudget,
  estimateMessageTokens,
  estimateToolSchemaTokens,
  selectContextMessages,
} from './context.js';
import { type EventRecord, createEvent } from './events.js';
import {
  type SessionIdentitySnapshot,
  captureSessionIdentity,
  identityStatus,
  identityWorkspace,
  sessionIdentityPrompt,
} from './identity.js';
import { registerRuntimeIntrospection } from './introspection.js';
import { assembleSystemPrompt } from './prompt.js';
import { SessionRunQueue } from './queue.js';
import { ToolExecutionError, isRepairableToolRejection } from './tool-errors.js';

export interface RuntimeOptions {
  root: string;
  config: RuntimeConfig;
  store: DatabaseStore;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  mcp?: McpManager;
  skills?: SkillRegistry;
  skillLearner?: SkillLearner;
  knowledgeLearner?: KnowledgeLearner;
  artifacts?: RunArtifactRegistry;
  resolvePermissions?: (source: string) => PermissionContext;
  onRunAdmitted?: (run: RunRow, request: RunRequest) => void;
}
export interface SessionIdentityOptions {
  workspaceRoot?: string;
  parentSessionId?: string;
  parentIdentitySnapshotId?: string;
}
export interface RunRequest {
  execution?: ExecutionRequest;
  parentRunId?: string;
  goalId?: string;
  continuationOf?: string;
  identitySnapshotId?: string;
  threadId: string;
  input: string;
  verificationInput?: string;
  images?: ProviderImage[];
  provider?: string;
  model?: string;
  idempotencyKey?: string;
  permissions?: PermissionContext;
  permissionSource?: string;
}
export type RuntimeListener = (event: EventRecord & { id: number }) => void;

export class RunRecoveryAuthorizationError extends Error {
  readonly code = 'RUN_RECOVERY_AUTHORIZATION_REQUIRED';
  constructor() {
    super(
      'Run recovery requires retained execution context and current authorization for its original authority source.',
    );
    this.name = 'RunRecoveryAuthorizationError';
  }
}

const modelDeltaBatchBytes = 256;
const modelDeltaBatchIntervalMs = 50;
const summaryCheckpointEnvelopeTokens = 192;
const finalizationInstruction =
  'The ordinary model-turn budget is exhausted. Do not request more tools. Provide the final answer now using only evidence already returned by completed calls, and state any remaining limitation plainly.';
const completionCorrectionInstruction =
  'Provide the final answer now using only completed work. Do not describe future work or promise another action. If the request was not completed, say so plainly.';

function appendUserInstruction(messages: ProviderMessage[], instruction: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${instruction}` };
    return;
  }
  messages.push({ role: 'user', content: instruction });
}

function transcriptSummaryContext(
  summary:
    | {
        version: number;
        sourceStartMessageId: string;
        sourceEndMessageId: string;
        sourceMessageCount: number;
        sourceSha256: string;
        sourceProvenance: string;
        summary: string;
      }
    | undefined,
): string | undefined {
  if (!summary) return undefined;
  return [
    `Deterministic extractive checkpoint v${summary.version}.`,
    `Source: ${summary.sourceStartMessageId}..${summary.sourceEndMessageId} (${summary.sourceMessageCount} messages).`,
    `Provenance: ${summary.sourceProvenance}:${summary.sourceSha256}.`,
    summary.summary || '[No complete source record fit within the summary token budget.]',
  ].join('\n');
}

function looksLikeFutureIntent(value: string): boolean {
  const trimmed = value.trim();
  return (
    Buffer.byteLength(trimmed, 'utf8') <= 320 &&
    /^(?:(?:okay|ok|sure|certainly|got it)[,.:;!\s-]*)?(?:i['’]ll|i will|let me)\s+(?:run|check|inspect|verify|try|look|explore|do)\b/i.test(
      trimmed,
    )
  );
}

export function requestRequiresVerifiedTool(input: string): boolean {
  return verificationRequiresEvidence(classifyVerificationPolicy(input));
}

type ProviderToolSchema = ReturnType<ToolRegistry['schemas']>[number];

interface RuntimeProviderDynamicTool extends ProviderDynamicTool {
  runtimeToolName: string;
}

export function selectProviderTools(
  input: string,
  tools: ProviderToolSchema[],
): ProviderToolSchema[] {
  return requestDisablesTools(input) ? [] : tools;
}

function selectCodexDynamicTools(
  tools: ToolRegistry,
  mcp: McpManager | undefined,
  permissions: PermissionContext,
  root: string,
  timeoutMs: number,
  signal?: AbortSignal,
  budget?: ToolBudget,
  executeTool?: (
    name: string,
    input: Record<string, unknown>,
    metadata?: ProviderDynamicToolCallMetadata,
  ) => Promise<unknown>,
): RuntimeProviderDynamicTool[] {
  const toolDefinitions =
    typeof (tools as ToolRegistry & { list?: unknown }).list === 'function'
      ? tools.list()
      : tools.schemas(permissions).map((tool) => ({ ...tool, permission: 'read' as const }));
  const registryToolNames = new Set(toolDefinitions.map((tool) => tool.name));
  const localTools = toolDefinitions
    .filter((tool) => permissions.approved.has(tool.permission))
    .map((tool) => ({
      runtimeToolName: tool.name,
      namespace: 'nuaai',
      name: tool.name.replaceAll('.', '_'),
      description: tool.description,
      parameters: tool.parameters,
      execute: (input: Record<string, unknown>, metadata?: ProviderDynamicToolCallMetadata) =>
        executeTool
          ? executeTool(tool.name, input, metadata)
          : tools.execute(tool.name, input, { root, permissions, budget, timeoutMs, signal }),
    }));
  const mcpTools = registryToolNames.has('mcp.execute')
    ? []
    : (mcp?.schemas(permissions) ?? []).map((tool) => ({
        runtimeToolName: tool.name,
        namespace: 'nuaai',
        name: tool.name.replaceAll('.', '_'),
        description: tool.description,
        parameters: tool.parameters,
        execute: (input: Record<string, unknown>) =>
          mcp?.execute(tool.name, input, permissions, signal) ??
          Promise.reject(new Error('MCP unavailable')),
      }));
  return [...localTools, ...mcpTools];
}

function normalizeNumericArguments(
  args: Record<string, unknown>,
  tool: ProviderToolSchema | undefined,
): Record<string, unknown> {
  if (!tool || typeof tool.parameters !== 'object' || tool.parameters === null) return args;
  const properties = (tool.parameters as { properties?: Record<string, { type?: string }> })
    .properties;
  if (!properties) return args;
  const normalized = { ...args };
  for (const [name, definition] of Object.entries(properties)) {
    const value = normalized[name];
    if (
      definition?.type === 'number' &&
      typeof value === 'string' &&
      /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())
    ) {
      const number = Number(value);
      if (Number.isFinite(number)) normalized[name] = number;
    }
  }
  return normalized;
}

function providerToolPayloadHash(input: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`nuaai-provider-tool-payload-v1\0${canonicalizeApprovalArguments(input)}`)
    .digest('hex');
}

function canonicalAttestationValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { type: 'number', value: 'NaN' };
    if (value === Number.POSITIVE_INFINITY) return { type: 'number', value: 'Infinity' };
    if (value === Number.NEGATIVE_INFINITY) return { type: 'number', value: '-Infinity' };
    if (Object.is(value, -0)) return { type: 'number', value: '-0' };
    return value;
  }
  if (typeof value === 'undefined') return { type: 'undefined' };
  if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
  if (value instanceof Error) return { type: 'error', name: value.name, message: value.message };
  if (value instanceof Date) return { type: 'date', value: value.toISOString() };
  if (value instanceof Uint8Array)
    return { type: 'bytes', value: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map((entry) => canonicalAttestationValue(entry, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new Error('Provider tool attestation value is circular');
    seen.add(value);
    const canonical = Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalAttestationValue((value as Record<string, unknown>)[key], seen),
        ]),
    );
    seen.delete(value);
    return canonical;
  }
  return { type: typeof value, value: String(value) };
}

function providerToolResultHash(value: unknown): string {
  return createHash('sha256')
    .update(`nuaai-provider-tool-result-v1\0${JSON.stringify(canonicalAttestationValue(value))}`)
    .digest('hex');
}

function providerToolFailureHashes(error: unknown): Set<string> {
  const message = error instanceof Error ? error.message : String(error);
  return new Set([
    providerToolResultHash(error),
    providerToolResultHash(message),
    providerToolResultHash({ error: message }),
    providerToolResultHash({ message }),
  ]);
}

interface ProviderToolStartAnnouncement {
  callId: string;
  qualifiedName: string;
  payloadHash: string;
}

interface ProviderToolAttestation {
  callId: string;
  qualifiedName: string;
  runtimeToolName: string;
  payloadHash: string;
  input: Record<string, unknown>;
  status: 'running' | 'succeeded' | 'failed';
  result?: unknown;
  resultHashes: Set<string>;
  startSeen: boolean;
  acknowledged: boolean;
}

function serializeBoundedToolResult(
  result: unknown,
  maxBytes: number,
): { content: string; value: unknown; bytes: number; truncated: boolean } {
  const serialized = JSON.stringify(result);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= maxBytes) return { content: serialized, value: result, bytes, truncated: false };
  const previewBytes = Math.max(256, Math.floor(maxBytes / 2));
  const preview = Buffer.from(serialized, 'utf8').subarray(0, previewBytes).toString('utf8');
  const value = {
    truncated: true,
    originalBytes: bytes,
    preview,
  };
  return {
    content: JSON.stringify(value),
    value,
    bytes,
    truncated: true,
  };
}

function normalizeToolCall(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  tools: ProviderToolSchema[],
): { id: string; name: string; arguments: Record<string, unknown>; requestedName?: string } {
  const available = new Set(tools.map((tool) => tool.name));
  let normalized: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    requestedName?: string;
  } = call;
  if (call.name === 'workspace' && typeof call.arguments.command === 'string') {
    if (available.has('workspace.command'))
      normalized = { ...call, name: 'workspace.command', requestedName: call.name };
  }
  if (
    (call.name === 'mcp__tools_list' || call.name === 'mcp.tools.list') &&
    available.has('mcp.discover')
  )
    normalized = { id: call.id, name: 'mcp.discover', arguments: {}, requestedName: call.name };
  if (
    normalized.name === 'github.repo.list' &&
    normalized.arguments.mode === 'count' &&
    normalized.arguments.limit === undefined
  )
    normalized = {
      ...normalized,
      arguments: { ...normalized.arguments, limit: 1000 },
    };
  return {
    ...normalized,
    arguments: normalizeNumericArguments(
      normalized.arguments,
      tools.find((tool) => tool.name === normalized.name),
    ),
  };
}

function requestsExactRepositoryCount(input: string): boolean {
  return (
    /\b(?:exact|verified)\b.{0,80}\b(?:count|number)\b/i.test(input) ||
    /\b(?:count|how many)\b.{0,80}\b(?:github\s+)?(?:repos?|repositories)\b/i.test(input)
  );
}

import {
  type ApprovalMode,
  SmartApprovalDeniedError,
  reviewApproval,
  sessionApprovalGrant,
} from './approval-policy.js';

import { HostCommandError } from '../host/command.js';

interface RunAuthority {
  source: string;
  permissions: PermissionContext;
}

interface ApprovalWaiter {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

class ApprovalWaitInterruptedError extends Error {
  constructor(runId: string) {
    super(`Approval wait interrupted for run ${runId}`);
    this.name = 'ApprovalWaitInterruptedError';
  }
}

interface ApprovedToolExecution {
  approval: ApprovalRequestRow;
  canonicalArguments: string;
  permissions: PermissionContext;
}

export class AgentRuntime {
  private readonly listeners = new Set<RuntimeListener>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runQueue = new SessionRunQueue();
  private readonly writerOwnerId = randomUUID();
  private readonly runAuthorities = new Map<string, RunAuthority>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();
  private readonly approvalPreviews = new Map<
    string,
    { payloadHash: string; preview: ApprovalPreviewV1 }
  >();
  private readonly approvalExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopping = false;
  private readonly releaseIntrospection: () => void;

  constructor(private readonly options: RuntimeOptions) {
    this.releaseIntrospection = registerRuntimeIntrospection(
      options.tools,
      options.store,
      () => this.status().context,
      () => options.knowledgeLearner?.status() ?? { available: false, enabled: false },
      (runId) => this.executionStatus(runId),
    );
    try {
      this.options.store.releaseAllRunWriters();
      this.recoverActiveRuns();
      this.recoverApprovalRuns();
    } catch (error) {
      this.releaseIntrospection();
      throw error;
    }
  }

  private failRecoveredRun(run: RunRow, output: string, approvalId?: string): void {
    this.addRunMessage(run, 'assistant', output, run.provider, run.model);
    this.options.store.updateRun(run.id, { status: 'failed', output });
    this.emit(
      'run.failed',
      { error: output, reason: 'approval_recovery', ...(approvalId ? { approvalId } : {}) },
      { threadId: run.threadId, runId: run.id, correlationId: run.correlationId },
    );
  }

  private recoverApprovalRuns(): void {
    const newestApprovalByRun = new Map<string, ApprovalRequestRow>();
    for (const approval of this.options.store.listApprovalRequests())
      if (!newestApprovalByRun.has(approval.runId))
        newestApprovalByRun.set(approval.runId, approval);

    for (const run of this.options.store.listActiveRuns()) {
      if (run.status !== 'paused') continue;
      const approval = newestApprovalByRun.get(run.id);
      if (!approval) {
        this.failRecoveredRun(
          run,
          'NUAAI found a paused run without an approval request after daemon restart. Resume manually.',
        );
        continue;
      }
      if (approval.status === 'pending') {
        if (approval.expiresAt <= Date.now()) this.expireApproval(approval.id);
        else this.scheduleApprovalExpiry(approval);
        continue;
      }
      if (approval.status === 'approved') {
        if (approval.expiresAt <= Date.now()) this.expireApproval(approval.id);
        else {
          this.scheduleApprovalExpiry(approval);
          this.resumeApprovedRun(approval);
        }
        continue;
      }
      if (approval.status === 'executed') {
        this.failRecoveredRun(
          run,
          `Action execution was claimed before daemon restart and will not be repeated: ${approval.toolName}`,
          approval.id,
        );
        continue;
      }
      const reason =
        approval.status === 'denied'
          ? `Action denied before daemon restart: ${approval.toolName}`
          : approval.status === 'expired'
            ? `Action approval expired before daemon restart: ${approval.toolName}`
            : `Action approval failed before daemon restart: ${approval.toolName}`;
      this.terminateApprovalRun(approval, reason);
    }
  }

  private recoverActiveRuns(): void {
    for (const run of this.options.store.listActiveRuns()) {
      if (run.status === 'paused') continue;
      const output = 'NUAAI run interrupted by daemon restart. Resume manually to continue.';
      this.options.store.updateRun(run.id, { status: 'failed', output });
      this.emit(
        'run.failed',
        { error: output, reason: 'daemon_restart' },
        { threadId: run.threadId, runId: run.id, correlationId: run.correlationId },
      );
    }
  }

  listApprovals(status?: ApprovalStatus): ApprovalRequestView[] {
    return this.options.store
      .listApprovalRequests(status)
      .map((approval) => this.approvalView(approval));
  }

  private approvalView(approval: ApprovalRequestRow): ApprovalRequestView {
    const view = publicApprovalRequest(approval);
    const live = this.approvalPreviews.get(approval.id);
    const preview =
      approval.status === 'pending' && live?.payloadHash === approval.payloadHash
        ? live.preview
        : view.preview;
    const scope = this.options.store.approvalScope(approval.id);
    return {
      ...view,
      preview: {
        ...preview,
        fields: scope
          ? [
              { label: 'Session scope', value: `${scope.tool} · ${scope.target}` },
              ...preview.fields,
            ]
          : preview.fields,
      },
    };
  }

  getApproval(id: string): ApprovalRequestView | undefined {
    const approval = this.options.store.getApprovalRequest(id);
    return approval ? this.approvalView(approval) : undefined;
  }

  sessionApprovalPolicy(sessionId: string) {
    return this.options.store.sessionApprovalPolicy(sessionId);
  }

  setSessionApprovalPolicy(sessionId: string, mode: ApprovalMode, revokeGrants = false) {
    const current = this.options.store.sessionApprovalPolicy(sessionId);
    const policy = { mode, grants: revokeGrants ? [] : current.grants };
    this.options.store.saveSessionApprovalPolicy(sessionId, policy);
    this.emit('approval.policy.changed', { mode, grants: policy.grants.length }, { sessionId });
    return policy;
  }

  approveApproval(
    id: string,
    payloadHash: string,
    scope: 'once' | 'session' = 'once',
  ): ApprovalRequestView {
    const approval = this.options.store.transaction(() => {
      const grant = scope === 'session' ? this.options.store.approvalScope(id) : undefined;
      if (scope === 'session' && !grant)
        throw new Error('Session scope unavailable for this legacy approval; approve once instead');
      const decided = this.options.store.decideApprovalRequest(
        id,
        'approved',
        Date.now(),
        payloadHash,
      );
      if (grant && decided.sessionId) {
        const policy = this.options.store.sessionApprovalPolicy(decided.sessionId);
        this.options.store.saveSessionApprovalPolicy(decided.sessionId, {
          ...policy,
          grants: [...policy.grants.filter((item) => item.key !== grant.key), grant].slice(-256),
        });
      }
      return decided;
    });
    this.emitApprovalEvent('approval.approved', approval);
    const waiter = this.approvalWaiters.get(id);
    if (waiter) waiter.resolve();
    else this.resumeApprovedRun(approval);
    return publicApprovalRequest(approval);
  }

  denyApproval(id: string, payloadHash: string): ApprovalRequestView {
    const approval = this.options.store.decideApprovalRequest(
      id,
      'denied',
      Date.now(),
      payloadHash,
    );
    this.clearApprovalExpiry(id);
    this.emitApprovalEvent('approval.denied', approval);
    this.terminateApprovalRun(approval, `Action denied: ${approval.toolName}`);
    this.approvalWaiters.get(id)?.reject(new ApprovalDeniedError(id));
    return publicApprovalRequest(approval);
  }

  private currentPermissions(runId: string, source: string): PermissionContext {
    const resolved = this.options.resolvePermissions?.(source);
    if (resolved) return resolved;
    const authority = this.runAuthorities.get(runId);
    if (authority?.source === source) return authority.permissions;
    return permissionContextForProfile('read-only');
  }

  private emitApprovalEvent(
    type:
      | 'approval.requested'
      | 'approval.approved'
      | 'approval.denied'
      | 'approval.expired'
      | 'approval.executed'
      | 'approval.failed',
    approval: ApprovalRequestRow,
  ): void {
    if (type !== 'approval.requested') this.approvalPreviews.delete(approval.id);
    this.emit(
      type,
      { ...publicApprovalRequest(approval) },
      {
        ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
        threadId: approval.threadId,
        runId: approval.runId,
      },
    );
  }

  private scheduleApprovalExpiry(approval: ApprovalRequestRow): void {
    this.clearApprovalExpiry(approval.id);
    const delay = Math.max(0, approval.expiresAt - Date.now());
    const timer = setTimeout(() => this.expireApproval(approval.id), delay);
    timer.unref();
    this.approvalExpiryTimers.set(approval.id, timer);
  }

  private clearApprovalExpiry(id: string): void {
    const timer = this.approvalExpiryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.approvalExpiryTimers.delete(id);
  }

  private expireApproval(id: string): void {
    this.clearApprovalExpiry(id);
    const approval = this.options.store.expireApprovalRequest(id);
    if (!approval || approval.status !== 'expired') return;
    this.emitApprovalEvent('approval.expired', approval);
    this.terminateApprovalRun(approval, `Action approval expired: ${approval.toolName}`);
    this.approvalWaiters.get(id)?.reject(new ApprovalExpiredError(id));
  }

  private terminateApprovalRun(approval: ApprovalRequestRow, output: string): void {
    const run = this.options.store.getRun(approval.runId);
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    this.addRunMessage(run, 'assistant', output, run.provider, run.model);
    this.options.store.updateRun(run.id, { status: 'failed', output });
    this.emit(
      'run.failed',
      { error: output, approvalId: approval.id },
      {
        ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
        threadId: approval.threadId,
        runId: approval.runId,
        correlationId: run.correlationId,
      },
    );
    this.controllers.get(run.id)?.abort(new Error(output));
  }

  private resumeApprovedRun(approval: ApprovalRequestRow): void {
    const run = this.options.store.getRun(approval.runId);
    if (!run || run.status !== 'paused') return;
    const stored = this.options.store.getRunExecutionContext(run.id);
    let permissions: PermissionContext;
    try {
      permissions = stored
        ? this.recoverExecutionContext(run.id).permissions
        : this.currentPermissions(run.id, approval.permissionSource);
    } catch (error) {
      this.terminateApprovalRun(
        approval,
        error instanceof Error ? error.message : 'Run recovery authorization failed',
      );
      return;
    }
    this.runAuthorities.set(run.id, { source: approval.permissionSource, permissions });
    const provider = this.options.providers.get(run.provider);
    this.enqueueRun(run, provider, permissions, approval.permissionSource, stored?.images, true);
  }

  private approvalWaiter(id: string): ApprovalWaiter {
    let resolveWaiter!: () => void;
    let rejectWaiter!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    const waiter: ApprovalWaiter = {
      promise,
      resolve: resolveWaiter,
      reject: rejectWaiter,
    };
    this.approvalWaiters.set(id, waiter);
    return waiter;
  }

  private pendingApprovalsForRun(runId: string): ApprovalRequestRow[] {
    return this.options.store
      .listApprovalRequests('pending')
      .filter((approval) => approval.runId === runId);
  }

  private interruptApprovalWait(runId: string): void {
    const error = new ApprovalWaitInterruptedError(runId);
    for (const approval of this.pendingApprovalsForRun(runId))
      this.approvalWaiters.get(approval.id)?.reject(error);
  }

  private denyPendingApprovalsForCancelledRun(runId: string): void {
    for (const approval of this.pendingApprovalsForRun(runId)) {
      try {
        const denied = this.options.store.decideApprovalRequest(
          approval.id,
          'denied',
          Date.now(),
          approval.payloadHash,
        );
        this.clearApprovalExpiry(approval.id);
        this.emitApprovalEvent('approval.denied', denied);
      } catch (error) {
        if (!(error instanceof ApprovalStateError)) throw error;
      }
      this.approvalWaiters.get(approval.id)?.reject(new ApprovalDeniedError(approval.id));
    }
  }

  private async awaitActionApproval(
    run: RunRow,
    sessionId: string,
    permissionSource: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
    permissions: PermissionContext,
    providerOwned: boolean,
    context: { budget?: ToolBudget; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ApprovedToolExecution | undefined> {
    const admission = this.options.tools.previewAdmission(toolName, input, {
      root: this.runIdentity(run).workspaceRoot,
      permissions,
      ...context,
      threadId: run.threadId,
      runId: run.id,
    });
    const forceReview = (input as Record<string, unknown> | null)?.requestApproval === true;
    if (admission.definition.governance.approval !== 'profile' && !forceReview) return undefined;
    const policy = this.options.store.sessionApprovalPolicy(sessionId);
    const grant = sessionApprovalGrant(
      toolName,
      admission.input as Record<string, unknown>,
      this.runIdentity(run).workspaceRoot,
      permissionSource,
    );
    if (
      policy.mode === 'unguarded' ||
      (!forceReview && policy.grants.some((item) => item.key === grant.key))
    ) {
      this.emit(
        'approval.policy.decision',
        {
          mode: policy.mode,
          toolName,
          decision: 'allow',
          source: policy.mode === 'unguarded' ? 'unguarded' : 'session_grant',
          scope: grant.key,
        },
        { sessionId, threadId: run.threadId, runId: run.id },
      );
      return undefined;
    }
    if (policy.mode === 'smart' && !forceReview) {
      const routine = [
        'workspace.write',
        'workspace.edit',
        'workspace.mkdir',
        'workspace.copy',
        'workspace.command',
        'github.auth',
        'github.repo.list',
        'skill.create',
      ].includes(toolName);
      const mandatoryHuman =
        ['workspace.trash', 'workspace.move', 'memory.forget'].includes(toolName) ||
        ['external', 'unknown'].includes(admission.definition.governance.sideEffects);
      const verdict =
        routine && !mandatoryHuman
          ? { decision: 'allow' as const, reason: 'Routine bounded local operation' }
          : mandatoryHuman
            ? {
                decision: 'ask' as const,
                reason: 'Destructive, external or unknown effect requires explicit human approval',
              }
            : await reviewApproval(
                this.options.providers.get(run.provider),
                run.model,
                {
                  userRequest: run.input,
                  tool: toolName,
                  arguments: admission.input,
                  sideEffects: admission.definition.governance.sideEffects,
                },
                context.signal,
              );
      this.emit(
        'approval.policy.decision',
        { mode: 'smart', toolName, ...verdict },
        { sessionId, threadId: run.threadId, runId: run.id },
      );
      // A concurrent policy change cannot be overruled by a stale model verdict.
      if (this.options.store.sessionApprovalPolicy(sessionId).mode === 'smart') {
        if (verdict.decision === 'deny') {
          const error = new SmartApprovalDeniedError(toolName, verdict.reason);
          this.addRunMessage(run, 'assistant', error.message, run.provider, run.model);
          this.options.store.updateRun(run.id, { status: 'failed', output: error.message });
          this.emit(
            'run.failed',
            { error: error.message, reason: 'approval_policy_denied', toolName },
            { sessionId, threadId: run.threadId, runId: run.id, correlationId: run.correlationId },
          );
          throw error;
        }
        if (verdict.decision === 'allow') return undefined;
      }
    }
    if (!admission.input || typeof admission.input !== 'object' || Array.isArray(admission.input))
      throw new Error(`Approval arguments must be an object: ${toolName}`);
    const parsedArguments = admission.input as Record<string, unknown>;
    const canonicalArguments = canonicalizeApprovalArguments(parsedArguments);
    const payloadHash = approvalPayloadHash(run.id, toolName, canonicalArguments);
    let approval = this.options.store
      .listApprovalRequests('approved')
      .find(
        (candidate) =>
          candidate.runId === run.id &&
          candidate.toolName === toolName &&
          candidate.payloadHash === payloadHash,
      );
    if (!approval) {
      const now = Date.now();
      const configuredTtl = (this.options.config.limits as { approvalTtlMs?: number })
        .approvalTtlMs;
      const ttl = Math.min(3_600_000, Math.max(1_000, configuredTtl ?? 900_000));
      approval = this.options.store.createApprovalRequest(
        {
          runId: run.id,
          threadId: run.threadId,
          sessionId,
          toolCallId,
          toolName,
          canonicalArguments,
          payloadHash,
          requiredPermission: admission.definition.permission,
          permissionSource,
          risk: `${admission.definition.governance.costClass} · ${admission.definition.governance.sideEffects}`,
          target: approvalTarget(toolName, parsedArguments),
          providerOwned,
          expiresAt: now + ttl,
        },
        now,
      );
      this.options.store.saveApprovalScope(approval.id, grant);
      const waiter = this.approvalWaiter(approval.id);
      this.approvalPreviews.set(approval.id, {
        payloadHash,
        preview: buildTransientApprovalPreview(toolName, parsedArguments, {
          permissionSource,
          sessionId,
        }),
      });
      this.options.store.updateRun(run.id, { status: 'paused' });
      this.emitApprovalEvent('approval.requested', approval);
      this.emit(
        'run.paused',
        { reason: 'approval_required', approvalId: approval.id },
        { sessionId, threadId: run.threadId, runId: run.id, correlationId: run.correlationId },
      );
      this.scheduleApprovalExpiry(approval);
      try {
        await waiter.promise;
      } finally {
        this.approvalWaiters.delete(approval.id);
        this.approvalPreviews.delete(approval.id);
      }
      approval = this.options.store.getApprovalRequest(approval.id) as ApprovalRequestRow;
    }
    if (approval.status !== 'approved')
      throw new ApprovalStateError(
        `Approval request ${approval.id} is not approved`,
        approval.status === 'expired' ? 'approval_expired' : 'approval_not_pending',
      );
    const currentPermissions = this.currentPermissions(run.id, permissionSource);
    try {
      const currentAdmission = this.options.tools.previewAdmission(toolName, input, {
        root: this.runIdentity(run).workspaceRoot,
        permissions: currentPermissions,
        ...context,
        threadId: run.threadId,
        runId: run.id,
      });
      if (
        !currentAdmission.input ||
        typeof currentAdmission.input !== 'object' ||
        Array.isArray(currentAdmission.input) ||
        canonicalizeApprovalArguments(currentAdmission.input as Record<string, unknown>) !==
          canonicalArguments
      )
        throw new ApprovalStateError(
          `Approval request ${approval.id} payload changed before execution`,
          'approval_payload_mismatch',
        );
    } catch (error) {
      const failed = this.options.store.failApprovalExecution(approval.id, error);
      this.clearApprovalExpiry(approval.id);
      this.emitApprovalEvent('approval.failed', failed);
      throw error;
    }
    this.options.store.updateRun(run.id, { status: 'running' });
    this.emit(
      'run.resumed',
      { approvalId: approval.id, reason: 'approval_granted' },
      { sessionId, threadId: run.threadId, runId: run.id, correlationId: run.correlationId },
    );
    return { approval, canonicalArguments, permissions: currentPermissions };
  }

  private async executeToolWithApproval(
    run: RunRow,
    sessionId: string,
    permissionSource: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
    permissions: PermissionContext,
    providerOwned: boolean,
    context: { budget?: ToolBudget; timeoutMs?: number; signal?: AbortSignal },
    onAuthorized?: () => void,
  ): Promise<unknown> {
    let approved: ApprovedToolExecution | undefined;
    try {
      approved = await this.awaitActionApproval(
        run,
        sessionId,
        permissionSource,
        toolCallId,
        toolName,
        input,
        permissions,
        providerOwned,
        context,
      );
      const result = await this.options.tools.execute(
        toolName,
        input,
        {
          root: this.runIdentity(run).workspaceRoot,
          permissions: approved?.permissions ?? permissions,
          ...context,
          threadId: run.threadId,
          runId: run.id,
        },
        () => {
          if (approved) {
            this.options.store.claimApprovalExecution(approved.approval.id, {
              runId: run.id,
              toolName,
              canonicalArguments: approved.canonicalArguments,
            });
            this.clearApprovalExpiry(approved.approval.id);
          }
          onAuthorized?.();
        },
      );
      if (approved) {
        const completed = this.options.store.completeApprovalExecution(
          approved.approval.id,
          result,
        );
        this.emitApprovalEvent('approval.executed', completed);
      }
      return result;
    } catch (error) {
      if (error instanceof HostCommandError) {
        this.addRunMessage(run, 'assistant', error.message, run.provider, run.model);
        this.options.store.updateRun(run.id, { status: 'failed', output: error.message });
        this.emit(
          'run.failed',
          { error: error.message, reason: 'host_command_partial_failure', toolName },
          { sessionId, threadId: run.threadId, runId: run.id, correlationId: run.correlationId },
        );
        this.controllers.get(run.id)?.abort(error);
      }
      if (approved) {
        const failed = this.options.store.failApprovalExecution(approved.approval.id, error);
        this.clearApprovalExpiry(approved.approval.id);
        this.emitApprovalEvent('approval.failed', failed);
      }
      throw error;
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
    const sessionId =
      context.sessionId ??
      (context.threadId ? this.options.store.getThread(context.threadId)?.sessionId : undefined);
    const event = this.options.store.appendEvent(
      createEvent(type, payload, { ...context, sessionId }),
    );
    for (const listener of this.listeners) listener(event);
  }

  private async captureToolArtifacts(
    run: RunRow,
    thread: ThreadRow,
    sourceTool: string,
    input: unknown,
    result: unknown,
    callId: string,
  ): Promise<void> {
    if (!this.options.artifacts) return;
    const eventContext = {
      sessionId: thread.sessionId,
      threadId: thread.id,
      runId: run.id,
      correlationId: run.correlationId,
    };
    let candidates: RunArtifactCandidate[];
    try {
      candidates = this.options.tools.artifactCandidates(sourceTool, input, result);
    } catch (error) {
      this.emit(
        'artifact.failed',
        {
          sourceTool,
          callId,
          error: error instanceof Error ? error.message : String(error),
          reason: 'candidate_extraction',
        },
        eventContext,
      );
      return;
    }
    for (const candidate of candidates) {
      try {
        const artifact = await this.options.artifacts.capture({
          ...candidate,
          ...(candidate.workspacePath
            ? {
                workspacePath: relative(
                  identityWorkspace(this.options.root),
                  await assertSafeProjectFile(
                    this.runIdentity(run).workspaceRoot,
                    candidate.workspacePath,
                  ),
                ),
              }
            : {}),
          runId: run.id,
          threadId: thread.id,
          sourceTool,
          metadata: { ...(candidate.metadata ?? {}), callId },
        });
        this.emit(
          'artifact.created',
          {
            artifactId: artifact.id,
            sourceTool,
            callId,
            kind: artifact.kind,
            title: artifact.title,
            mimeType: artifact.mimeType,
            byteSize: artifact.byteSize,
            sha256: artifact.sha256,
            ...(artifact.externalUrl ? { externalUrl: artifact.externalUrl } : {}),
          },
          eventContext,
        );
      } catch (error) {
        this.emit(
          'artifact.failed',
          {
            sourceTool,
            callId,
            kind: candidate.kind,
            title: candidate.title,
            error: error instanceof Error ? error.message : String(error),
            reason: 'capture',
          },
          eventContext,
        );
      }
    }
  }

  createSession(
    title?: string,
    sourceKey?: string,
    id?: string,
    options: SessionIdentityOptions = {},
  ): { session: SessionRow; thread: ThreadRow } {
    const sessionId = id ?? randomUUID();
    const parent = options.parentSessionId
      ? options.parentIdentitySnapshotId
        ? this.options.store.getSessionIdentity(
            options.parentSessionId,
            options.parentIdentitySnapshotId,
          )
        : this.ensureSessionIdentity(options.parentSessionId)
      : undefined;
    if (options.parentIdentitySnapshotId && !parent)
      throw new Error('Pinned parent identity is unavailable.');
    if (
      parent &&
      options.workspaceRoot &&
      identityWorkspace(this.options.root, options.workspaceRoot) !== parent.workspaceRoot
    )
      throw new Error('A child session must inherit its parent workspace.');
    const snapshot = captureSessionIdentity({
      root: this.options.root,
      workspaceRoot: options.workspaceRoot,
      sessionId,
      parent,
    });
    const created = this.options.store.transaction(() => {
      const value = this.options.store.createSession(title, Date.now(), '', sourceKey, sessionId);
      this.options.store.saveSessionIdentity(snapshot);
      return value;
    });
    this.emit('session.identity.changed', identityStatus(snapshot), { sessionId });
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
    options: SessionIdentityOptions = {},
  ): { session: SessionRow; thread: ThreadRow } {
    const existing = this.options.store.getSessionBySource(sourceKey);
    if (existing) {
      this.ensureSessionIdentity(existing.id, options.workspaceRoot);
      const thread = this.options.store.listThreads(existing.id)[0];
      if (!thread) throw new Error(`Session has no thread: ${existing.id}`);
      this.emit('session.resumed', { title: existing.title }, { sessionId: existing.id });
      return { session: existing, thread };
    }
    return this.createSession(title, sourceKey, undefined, options);
  }

  private ensureSessionIdentity(
    sessionId: string,
    workspaceRoot?: string,
  ): SessionIdentitySnapshot {
    const session = this.options.store.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const existing = this.options.store.getSessionIdentity(sessionId);
    if (existing) {
      if (
        workspaceRoot &&
        identityWorkspace(this.options.root, workspaceRoot) !== existing.workspaceRoot
      )
        throw new Error('The existing session belongs to another workspace; create a new session.');
      return existing;
    }
    const snapshot = captureSessionIdentity({
      root: this.options.root,
      workspaceRoot,
      sessionId,
      origin: session.context.trim() ? 'legacy-retained' : 'legacy-captured',
      legacyContext: session.context,
    });
    this.options.store.saveSessionIdentity(snapshot);
    this.emit('session.identity.changed', identityStatus(snapshot), { sessionId });
    return snapshot;
  }

  sessionIdentityStatus(sessionId: string) {
    return identityStatus(this.ensureSessionIdentity(sessionId));
  }

  refreshSessionIdentity(sessionId: string) {
    const previous = this.ensureSessionIdentity(sessionId);
    const parent = previous.inheritedFrom
      ? this.ensureSessionIdentity(previous.inheritedFrom.sessionId)
      : undefined;
    const snapshot = captureSessionIdentity({
      root: this.options.root,
      workspaceRoot: previous.workspaceRoot,
      sessionId,
      revision: previous.revision + 1,
      origin: 'refreshed',
      parent,
    });
    this.options.store.transaction(() => {
      this.options.store.saveSessionIdentity(snapshot);
      const session = this.options.store.getSession(sessionId);
      if (previous.origin === 'legacy-retained' && session)
        this.options.store.updateSessionContext(sessionId, '');
    });
    this.emit('session.identity.changed', identityStatus(snapshot), { sessionId });
    return identityStatus(snapshot);
  }

  private runIdentity(run: RunRow): SessionIdentitySnapshot {
    const thread = this.options.store.getThread(run.threadId);
    if (!thread) throw new Error(`Unknown thread: ${run.threadId}`);
    const id = this.options.store.getRunExecutionContext(run.id)?.identitySnapshotId;
    const snapshot = id
      ? this.options.store.getSessionIdentity(thread.sessionId, id)
      : this.ensureSessionIdentity(thread.sessionId);
    if (!snapshot)
      throw new Error('The run identity snapshot is missing; refusing to change its instructions.');
    const physical = identityWorkspace(this.options.root, snapshot.workspaceRoot);
    if (physical !== snapshot.workspaceRoot)
      throw new Error('Session workspace changed its physical boundary.');
    return snapshot;
  }

  startNewSession(
    sourceKey: string,
    title?: string,
    idempotencyKey?: string,
  ): { session: SessionRow; thread: ThreadRow } {
    const digest = idempotencyKey
      ? createHash('sha256').update(`${sourceKey}\0${idempotencyKey}`).digest('hex')
      : undefined;
    const id = digest
      ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
      : undefined;
    return this.options.store.transaction(() => {
      if (id) {
        const existing = this.options.store.getSession(id);
        if (existing) {
          if (!this.sessionBelongsToSource(sourceKey, existing))
            throw new Error(`Idempotency key collision: ${idempotencyKey}`);
          const thread = this.options.store.listThreads(existing.id)[0];
          if (!thread) throw new Error(`Session has no thread: ${existing.id}`);
          return { session: existing, thread };
        }
      }
      const existing = this.options.store.getSessionBySource(sourceKey);
      if (existing) this.archiveSourceBinding(sourceKey, existing);
      return this.createSession(title ?? 'New session', sourceKey, id);
    });
  }

  switchSession(sourceKey: string, sessionId: string): { session: SessionRow; thread: ThreadRow } {
    const target = this.options.store.getSession(sessionId);
    if (!target) throw new Error(`Unknown session: ${sessionId}`);
    if (!this.sessionBelongsToSource(sourceKey, target))
      throw new Error(`Session ${sessionId} does not belong to this source`);
    const thread = this.options.store.listThreads(sessionId)[0];
    if (!thread) throw new Error(`Session has no thread: ${sessionId}`);
    this.options.store.transaction(() => {
      const current = this.options.store.getSessionBySource(sourceKey);
      if (current && current.id !== sessionId) this.archiveSourceBinding(sourceKey, current);
      this.options.store.setSessionSourceKey(sessionId, sourceKey);
      const historyPrefix = `${sourceKey}:history:${sessionId}:thread:`;
      for (const targetThread of this.options.store.listThreads(sessionId)) {
        if (!targetThread.sourceKey?.startsWith(historyPrefix)) continue;
        this.options.store.setThreadSourceKey(
          targetThread.id,
          `${sourceKey}:${targetThread.sourceKey.slice(historyPrefix.length)}`,
        );
      }
    });
    const resumed = this.options.store.getSession(sessionId) ?? target;
    this.emit('session.resumed', { title: resumed.title }, { sessionId: resumed.id });
    return { session: resumed, thread };
  }

  listSessionsForSource(sourceKey: string): SessionRow[] {
    return this.options.store
      .listSessions()
      .filter((session) => this.sessionBelongsToSource(sourceKey, session));
  }

  private sessionBelongsToSource(sourceKey: string, session: SessionRow): boolean {
    return (
      session.sourceKey === sourceKey ||
      session.sourceKey?.startsWith(`${sourceKey}:history:`) === true
    );
  }

  private archiveSourceBinding(sourceKey: string, session: SessionRow): void {
    this.options.store.setSessionSourceKey(session.id, `${sourceKey}:history:${session.id}`);
    for (const thread of this.options.store.listThreads(session.id)) {
      if (!thread.sourceKey?.startsWith(`${sourceKey}:`)) continue;
      this.options.store.setThreadSourceKey(
        thread.id,
        `${sourceKey}:history:${session.id}:thread:${thread.sourceKey.slice(sourceKey.length + 1)}`,
      );
    }
  }

  listSessions(includeOrphans = true): SessionRow[] {
    return this.options.store.listSessions(includeOrphans);
  }
  getSession(id: string): SessionRow | undefined {
    return this.options.store.getSession(id);
  }
  listThreads(sessionId: string): ThreadRow[] {
    return this.options.store.listThreads(sessionId);
  }
  createThread(sessionId: string, title?: string, sourceKey?: string): ThreadRow {
    const thread = this.options.store.createThread(sessionId, title, Date.now(), sourceKey);
    this.emit('thread.created', { title: thread.title }, { sessionId, threadId: thread.id });
    return thread;
  }
  getOrCreateThread(sessionId: string, sourceKey: string, title?: string): ThreadRow {
    const existing = this.options.store.getThreadBySource(sourceKey);
    if (existing) return existing;
    const threads = this.options.store.listThreads(sessionId);
    if (sourceKey.endsWith(':main') && threads[0] && !threads[0].sourceKey) {
      this.options.store.setThreadSourceKey(threads[0].id, sourceKey);
      return this.options.store.getThread(threads[0].id) ?? threads[0];
    }
    return this.createThread(sessionId, title ?? 'New thread', sourceKey);
  }
  deleteThread(threadId: string): boolean {
    return this.options.store.deleteThread(threadId);
  }
  deleteSession(sessionId: string): boolean {
    return this.options.store.deleteSession(sessionId);
  }
  renameThread(threadId: string, title: string): boolean {
    return this.options.store.renameThread(threadId, title);
  }
  renameSession(sessionId: string, title: string): boolean {
    return this.options.store.renameSession(sessionId, title);
  }
  listMessages(threadId: string) {
    return this.options.store.listMessages(threadId);
  }

  private addRunMessage(
    run: RunRow,
    role: string,
    content: string,
    provider?: string,
    model?: string,
  ): MessageRow {
    const message = this.options.store.addMessage(run.threadId, role, content, provider, model);
    this.options.store.storeMessageArtifact(message.id, 'run_link', { runId: run.id });
    return message;
  }

  private activeProvider(): { name: string; model: string } {
    const registry = this.options.providers as ProviderRegistry & {
      active?: () => { name: string; model: string };
    };
    if (registry.active) return registry.active();
    const name = this.options.config.provider.name;
    return { name, model: registry.get(name).model };
  }

  startRun(incoming: RunRequest): RunRow {
    if (this.stopping) throw new Error('Runtime is shutting down');
    if (!incoming.input.trim()) throw new Error('Run input is required');
    const execution = executionRequestSchema.parse(incoming.execution ?? { mode: 'standard' });
    const request = { ...incoming, execution };
    if (execution.mode === 'continuous' && !this.options.onRunAdmitted)
      throw new Error('Continuous work is unavailable without its durable goal owner');
    if (request.idempotencyKey) {
      const existing = this.options.store.getRunByCorrelationId(request.idempotencyKey);
      if (existing) {
        if (
          existing.threadId !== request.threadId ||
          existing.input !== request.input ||
          JSON.stringify(
            this.options.store.getRunExecutionContext(existing.id)?.requestedExecution ?? {
              mode: 'standard',
            },
          ) !== JSON.stringify(execution)
        )
          throw new Error(`Idempotency key collision: ${request.idempotencyKey}`);
        return existing;
      }
    }
    const active = this.activeProvider();
    const providerName = request.provider ?? active.name;
    const provider = this.options.providers.get(providerName);
    const registry = this.options.providers as ProviderRegistry & {
      selection?: (name: string) => { name: string; model: string };
    };
    const model =
      request.model ??
      (providerName === active.name
        ? active.model
        : (registry.selection?.(providerName).model ?? provider.model));
    const thread = this.options.store.getThread(request.threadId);
    if (!thread) throw new Error(`Unknown thread: ${request.threadId}`);
    const identity = request.identitySnapshotId
      ? this.options.store.getSessionIdentity(thread.sessionId, request.identitySnapshotId)
      : this.ensureSessionIdentity(thread.sessionId);
    if (!identity) throw new Error('Requested run identity snapshot is missing.');
    const correlationId = request.idempotencyKey ?? randomUUID();
    const run = this.options.store.createRun(
      thread.id,
      request.input,
      provider.name,
      model,
      correlationId,
    );

    this.emit(
      'run.created',
      { input: request.input, provider: provider.name, model },
      { sessionId: thread.sessionId, threadId: thread.id, runId: run.id, correlationId },
    );
    this.emit(
      'run.queued',
      { provider: provider.name, model, activeRun: this.runQueue.activeRun(thread.id) },
      { sessionId: thread.sessionId, threadId: thread.id, runId: run.id, correlationId },
    );
    const permissions = request.permissions ?? permissionContextForProfile('read-only');
    const permissionSource = request.permissionSource ?? 'direct';
    this.options.store.saveRunExecutionContext(run.id, {
      identitySnapshotId: identity.id,
      verificationInput: request.verificationInput ?? request.input,
      requestedExecution: execution,
      permissionSource,
      ...(request.goalId ? { goalId: request.goalId, continuationOf: request.continuationOf } : {}),
      permissions: {
        approved: [...permissions.approved].filter(
          (level): level is 'read' | 'write' | 'execute' => level !== 'secret',
        ),
        capabilities: { ...permissions.capabilities, secrets: false },
      },
      ...(request.images?.length ? { images: structuredClone(request.images) } : {}),
    });
    try {
      this.options.onRunAdmitted?.(run, request);
    } catch (error) {
      const detail = redactText(error instanceof Error ? error.message : String(error));
      this.options.store.updateRun(run.id, { status: 'failed', output: detail });
      this.emit(
        'run.failed',
        { error: detail, failureCode: 'RUN_ADMISSION_REJECTED', executionState: 'not_executed' },
        { runId: run.id, threadId: run.threadId, correlationId: run.correlationId },
      );
      throw error;
    }
    this.runAuthorities.set(run.id, { source: permissionSource, permissions });
    this.enqueueRun(run, provider, permissions, permissionSource, request.images);
    return run;
  }

  private enqueueRun(
    run: RunRow,
    provider: ProviderAdapter,
    permissions: PermissionContext,
    permissionSource: string,
    images?: ProviderImage[],
    resuming = false,
  ): void {
    void this.runQueue.enqueue(run.threadId, run.id, () =>
      this.executeRun(run, provider, permissions, permissionSource, images, resuming),
    );
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
    if (run.status === 'queued' || run.status === 'paused') {
      const output = 'NUAAI run cancelled before execution.';
      this.options.store.updateRun(runId, { status: 'cancelled', output });
      if (run.status === 'paused') this.denyPendingApprovalsForCancelledRun(runId);
      this.emit(
        'run.cancelled',
        { output, reason: 'cancelled_before_execution' },
        { threadId: run.threadId, runId, correlationId: run.correlationId },
      );
    }
  }

  async shutdown(): Promise<void> {
    this.approvalPreviews.clear();
    if (!this.stopping) {
      this.stopping = true;
      for (const run of this.options.store.listActiveRuns()) {
        if (run.status === 'queued') this.cancelRun(run.id);
        else if (run.status === 'paused') this.interruptApprovalWait(run.id);
        else {
          this.options.store.requestRunCancel(run.id);
          this.controllers.get(run.id)?.abort(new Error('Daemon stopping'));
        }
      }
      for (const timer of this.approvalExpiryTimers.values()) clearTimeout(timer);
      this.approvalExpiryTimers.clear();
    }
    await this.runQueue.drain();
    this.releaseIntrospection();
  }

  private recoverExecutionContext(runId: string) {
    const stored = this.options.store.getRunExecutionContext(runId);
    if (!stored) throw new RunRecoveryAuthorizationError();
    const current =
      this.options.resolvePermissions?.(stored.permissionSource) ??
      (stored.permissionSource === 'direct' &&
      stored.permissions.approved.every((level) => level === 'read')
        ? permissionContextForProfile('read-only')
        : undefined);
    if (!current) throw new RunRecoveryAuthorizationError();
    const permissions: PermissionContext = {
      approved: new Set(stored.permissions.approved.filter((level) => current.approved.has(level))),
      capabilities: Object.fromEntries(
        Object.entries(stored.permissions.capabilities).map(([key, value]) => [
          key,
          value === true &&
            current.capabilities[key as keyof PermissionContext['capabilities']] === true,
        ]),
      ),
    };
    return {
      permissionSource: stored.permissionSource,
      permissions,
      images: stored.images,
      verificationInput: stored.verificationInput,
      identitySnapshotId: stored.identitySnapshotId,
    };
  }

  continueGoalRun(runId: string, goalId: string, idempotencyKey: string): RunRow {
    const goal = this.options.store.getGoal(goalId);
    const previous = this.options.store.getRun(runId);
    if (!goal || goal.status !== 'queued' || goal.currentRunId !== runId || !previous)
      throw new Error('Goal is no longer eligible for continuation');
    return this.startRun({
      ...this.recoverExecutionContext(runId),
      threadId: previous.threadId,
      input: previous.input,
      goalId,
      continuationOf: runId,
      idempotencyKey,
    });
  }

  async waitForGoalResult(runId: string): Promise<{ status: string; output: string; run: RunRow }> {
    const first = await this.waitForRun(runId);
    for (;;) {
      const goalId = this.options.store.getRunExecutionContext(runId)?.goalId;
      const goal = goalId && this.options.store.getGoal(goalId);
      if (!goal) return { status: first.status, output: first.output ?? '', run: first };
      const current = this.options.store.getRun(goal.currentRunId);
      if (!current) throw new Error('Goal current run is unavailable');
      if (['completed', 'blocked', 'cancelled', 'superseded'].includes(goal.status))
        return {
          status:
            goal.status === 'completed'
              ? 'completed'
              : goal.status === 'cancelled'
                ? 'cancelled'
                : 'failed',
          output:
            goal.status === 'completed'
              ? (current.output ?? '')
              : (goal.checkpoint.reason ?? current.output ?? ''),
          run: current,
        };
      if (['failed', 'cancelled'].includes(current.status))
        return { status: current.status, output: current.output ?? '', run: current };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  childPermissions(parentRunId: string, ceiling: PermissionContext): PermissionContext {
    const { permissions } = this.recoverExecutionContext(parentRunId);
    return {
      approved: new Set([...ceiling.approved].filter((level) => permissions.approved.has(level))),
      capabilities: Object.fromEntries(
        Object.entries(ceiling.capabilities).map(([key, value]) => [
          key,
          value === true &&
            permissions.capabilities[key as keyof PermissionContext['capabilities']] === true,
        ]),
      ),
    };
  }

  /** Explicit retry in a new run, not automatic replay of interrupted side effects. */
  resumeRun(runId: string): RunRow {
    const run = this.options.store.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (!['failed', 'cancelled'].includes(run.status))
      throw new Error(`Run ${runId} is not resumable`);
    const recovery = this.recoverExecutionContext(runId);
    const resumed = this.startRun({
      threadId: run.threadId,
      input: run.input,
      provider: run.provider,
      model: run.model,
      ...recovery,
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
  executionStatus(runId?: string) {
    const limits = this.options.config.limits;
    const goalId = runId ? this.options.store.getRunExecutionContext(runId)?.goalId : undefined;
    const goal = goalId ? this.options.store.getGoal(goalId) : undefined;
    const family = goal?.checkpoint.familyRootId
      ? this.options.store.getGoal(goal.checkpoint.familyRootId)
      : goal;
    const policy = goal?.checkpoint.policy;
    const admissionsUsed = family?.checkpoint.familyAdmissions ?? 0;
    return {
      automaticContinuation: Boolean(this.options.onRunAdmitted),
      standard: executionPolicy(undefined, limits),
      continuous: {
        explicitAllowanceRequired: true,
        maxDurationMs: MAX_GOAL_DURATION_MS,
        maxRuns: MAX_GOAL_RUNS,
      },
      slice: {
        runTimeoutMs: limits.runTimeoutMs,
        modelTimeoutMs: limits.providerTimeoutMs,
        toolTimeoutMs: limits.toolTimeoutMs,
        maxTurns: limits.maxTurns,
        maxToolCalls: limits.maxToolCalls,
        maxToolCostUnits: limits.maxToolCostUnits,
      },
      goal:
        goal && policy
          ? {
              id: goal.id,
              status: goal.status,
              ...policy,
              deadlineAt: goal.checkpoint.deadlineAt,
              sliceCount: goal.sliceCount,
              admissionsUsed,
              admissionsRemaining: Math.max(0, policy.maxRuns - admissionsUsed),
            }
          : null,
    };
  }

  listTools(): ToolDescription[] {
    return this.options.tools.listTools();
  }

  getTool(name: string): ToolDescription | null {
    return this.options.tools.getTool(name);
  }

  getToolSchema(name: string): Record<string, unknown> | null {
    return this.options.tools.getToolSchema(name);
  }

  status(): {
    activeRuns: number;
    execution: ReturnType<AgentRuntime['executionStatus']>;
    queuedRuns: number;
    sessions: number;
    providers: string[];
    active: { name: string; model: string };
    capabilities: ReturnType<AgentRuntime['capabilities']>;
    context: {
      estimator: 'utf8-bytes-per-3-v1';
      maxTokens: number;
      responseReserveTokens: number;
      maxSummaryTokens: number;
    };
  } {
    return {
      activeRuns: this.controllers.size,
      execution: this.executionStatus(),
      queuedRuns: this.runQueue.queuedRuns(),
      sessions: this.options.store.listSessions().length,
      providers: this.options.providers.list(),
      active: this.activeProvider(),
      capabilities: this.capabilities(),
      context: {
        estimator: 'utf8-bytes-per-3-v1',
        maxTokens: Math.min(
          this.options.config.limits.maxContextTokens,
          this.options.config.provider.contextWindow,
        ),
        responseReserveTokens: this.options.config.limits.contextResponseReserveTokens,
        maxSummaryTokens: this.options.config.limits.maxContextSummaryTokens,
      },
    };
  }

  capabilities(
    permissions: PermissionContext = permissionContextForProfile('read-only'),
    input = '',
  ) {
    const active = this.activeProvider();
    const provider = this.options.providers.get(active.name);
    const dynamicTools = provider.ownsToolLoop
      ? selectCodexDynamicTools(
          this.options.tools,
          this.options.mcp,
          permissions,
          this.options.root,
          this.options.config.limits.toolTimeoutMs,
        )
      : [];
    return buildCapabilityManifest({
      provider,
      model: active.model,
      root: this.options.root,
      permissions,
      tools: this.options.tools,
      dynamicTools,
      verificationPolicy: classifyVerificationPolicy(input),
    });
  }

  private async executeRun(
    run: RunRow,
    provider: ProviderAdapter,
    permissions: PermissionContext,
    permissionSource: string,
    images?: ProviderImage[],
    resuming = false,
  ): Promise<void> {
    const queued = this.options.store.getRun(run.id);
    if (!queued || ['completed', 'failed', 'cancelled'].includes(queued.status)) return;
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    let writerClaimed = false;
    const goalId = this.options.store.getRunExecutionContext(run.id)?.goalId;
    const deadlineAt = goalId
      ? this.options.store.getGoal(goalId)?.checkpoint.deadlineAt
      : undefined;
    const remaining = deadlineAt ? Date.parse(deadlineAt) - Date.now() : Number.POSITIVE_INFINITY;
    const duration = Math.min(this.options.config.limits.runTimeoutMs, remaining);
    const timeoutReason = duration === remaining ? 'Goal deadline reached' : 'Run timed out';
    const timeout = setTimeout(
      () => controller.abort(new Error(timeoutReason)),
      Math.max(0, duration),
    );
    if (remaining <= 0) controller.abort(new Error('Goal deadline reached'));
    try {
      controller.signal.throwIfAborted();
      this.options.store.updateRun(run.id, { status: 'running' });
      const thread = this.options.store.getThread(run.threadId);
      if (!thread) throw new Error(`Unknown thread: ${run.threadId}`);
      writerClaimed = this.options.store.claimRunWriter(thread.id, run.id, this.writerOwnerId);
      if (!writerClaimed) throw new Error('Run could not claim the active transcript writer');
      const identity = this.runIdentity(run);
      const workspaceRoot = identity.workspaceRoot;
      const model = run.model;
      const continuationOf = this.options.store.getRunExecutionContext(run.id)?.continuationOf;
      const existingInputMessage = resuming
        ? this.options.store
            .listMessages(thread.id, 100_000)
            .filter((message) => message.role === 'user' && message.content === run.input)
            .at(-1)
        : undefined;
      const inputMessage =
        existingInputMessage ??
        this.addRunMessage(
          run,
          continuationOf ? 'system' : 'user',
          continuationOf
            ? 'Continue the existing user request using the durable recorded outcomes. This is a runtime continuation, not a new user message. Do not repeat completed effects or infer approval from this checkpoint.'
            : run.input,
          provider.name,
          model,
        );
      if (!resuming)
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
      let generatedOutputBytes = 0;
      let finalResponseAccepted = false;
      let toolBudgetExhausted = false;
      let toolBudgetNoticeAdded = false;
      let toolActivity = false;
      const verificationObservations: VerificationObservation[] = [];
      let verifiedRepositoryCount: number | null = null;
      let finalizationRequested = false;
      let recoveryRequested = false;
      let rejectedCapabilityClaim = false;
      let capabilityCheckRequested = false;
      let modelTurnBudgetExhausted = false;
      const unresolvedToolFailures: string[] = [];
      const repeatedInvalidCalls = new Map<string, number>();
      const toolBudget = createToolBudget(
        this.options.config.limits.maxToolCalls,
        this.options.config.limits.maxToolCostUnits,
      );
      // Attached source material is evidence/data, not additional user requirements.
      const verificationInput =
        this.options.store.getRunExecutionContext(run.id)?.verificationInput ?? run.input;
      const verificationPolicy = classifyVerificationPolicy(verificationInput);

      let memoryContext = '';
      {
        let retrievalMode: 'semantic' | 'lexical' = 'semantic';
        let retrieved: Array<{ id: string; content: string; metadata: Record<string, unknown> }> =
          [];
        try {
          const embedding = await this.options.providers.get('ollama').embed(run.input);
          retrieved = this.options.store.searchMemory(embedding, 4, workspaceRoot);
        } catch {
          retrievalMode = 'lexical';
          retrieved = this.options.store.searchMemoryLexical(run.input, 4, workspaceRoot);
        }
        if (!retrieved.length && retrievalMode === 'semantic') {
          retrievalMode = 'lexical';
          retrieved = this.options.store.searchMemoryLexical(run.input, 4, workspaceRoot);
        }
        const learned = this.options.store
          .searchMemoryLexical(run.input, 4, workspaceRoot)
          .filter((memory) => Boolean(memory.metadata.knowledge));
        retrieved = [
          ...new Map([...learned, ...retrieved].map((memory) => [memory.id, memory])).values(),
        ].slice(0, 4);
        const usableMemory = retrieved.filter((memory) => !isCapabilityRefusal(memory.content));
        const memoryEntries = usableMemory.map((memory) => `- ${memory.content}`);
        let memoryBytes = 0;
        const boundedMemory: string[] = [];
        for (const entry of memoryEntries) {
          const separatorBytes = boundedMemory.length ? 1 : 0;
          const remaining =
            this.options.config.limits.maxMemoryContextBytes - memoryBytes - separatorBytes;
          if (remaining <= 0) break;
          const entryBytes = Buffer.byteLength(entry, 'utf8');
          const suffix = '…';
          const bounded =
            entryBytes <= remaining
              ? entry
              : `${entry.slice(0, Math.max(0, remaining - Buffer.byteLength(suffix, 'utf8')))}${suffix}`;
          boundedMemory.push(bounded);
          memoryBytes += separatorBytes + Buffer.byteLength(bounded, 'utf8');
          if (bounded !== entry) break;
        }
        memoryContext = boundedMemory.join('\n');
        this.emit(
          'memory.retrieved',
          {
            count: usableMemory.length,
            filtered: retrieved.length - usableMemory.length,
            mode: retrievalMode,
          },
          {
            sessionId: thread.sessionId,
            threadId: thread.id,
            runId: run.id,
            correlationId: run.correlationId,
          },
        );
      }
      const pinnedMemory = this.options.store
        .searchMemoryRows()
        .filter(
          (memory) =>
            memory.metadata.pinned === true &&
            memoryVisibleInWorkspace(memory.metadata, workspaceRoot) &&
            !isCapabilityRefusal(memory.content),
        )
        .map((memory) => `- ${memory.content}`);
      if (pinnedMemory.length) {
        const existingEntries = new Set(memoryContext ? memoryContext.split('\n') : []);
        memoryContext = [
          ...pinnedMemory,
          ...[...existingEntries].filter((entry) => entry && !pinnedMemory.includes(entry)),
        ].join('\n');
      }
      const registeredTools = this.options.tools.schemas(permissions);
      const registeredToolNames = new Set(registeredTools.map((tool) => tool.name));
      const registryOwnsMcp =
        typeof (this.options.tools as ToolRegistry & { list?: unknown }).list === 'function' &&
        this.options.tools.list().some((tool) => tool.name === 'mcp.execute');
      const exposedMcpTools = registryOwnsMcp ? [] : (this.options.mcp?.schemas(permissions) ?? []);
      const availableTools = [...registeredTools, ...exposedMcpTools];
      const providerOwnsToolLoop = provider.ownsToolLoop === true;
      const providerTools = providerOwnsToolLoop
        ? []
        : selectProviderTools(run.input, availableTools);
      const providerToolStarts = new Map<string, ProviderToolStartAnnouncement>();
      const providerToolAttestations = new Map<string, ProviderToolAttestation>();
      const reportProviderToolViolation = (
        callId: string,
        qualifiedName: string,
        message: string,
        reason: 'unadvertised_provider_event' | 'unattested_provider_event',
      ): void => {
        unresolvedToolFailures.push(`${qualifiedName}: ${message}`);
        this.emit(
          'tool.failed',
          { id: callId, name: qualifiedName, providerOwned: true, reason, error: message },
          {
            sessionId: thread.sessionId,
            threadId: thread.id,
            runId: run.id,
            correlationId: run.correlationId,
          },
        );
      };
      const rawProviderDynamicTools = providerOwnsToolLoop
        ? selectCodexDynamicTools(
            this.options.tools,
            this.options.mcp,
            permissions,
            workspaceRoot,
            this.options.config.limits.toolTimeoutMs,
            controller.signal,
            toolBudget,
            (toolName, input, metadata) => {
              if (!metadata)
                return Promise.reject(
                  new Error(
                    'Provider-owned dynamic tool execution requires call attestation metadata',
                  ),
                );
              return this.executeToolWithApproval(
                run,
                thread.sessionId,
                permissionSource,
                metadata.callId,
                toolName,
                input,
                permissions,
                true,
                {
                  budget: toolBudget,
                  timeoutMs: this.options.config.limits.toolTimeoutMs,
                  signal: controller.signal,
                },
              );
            },
          )
        : [];
      const providerDynamicTools: ProviderDynamicTool[] = rawProviderDynamicTools.map(
        ({ runtimeToolName, ...tool }) => {
          const qualifiedName = `${tool.namespace}.${tool.name}`;
          return {
            ...tool,
            execute: async (
              input: Record<string, unknown>,
              metadata?: ProviderDynamicToolCallMetadata,
            ): Promise<unknown> => {
              const callId = metadata?.callId?.trim() ?? '';
              if (!callId || metadata?.qualifiedName !== qualifiedName) {
                const message = `Provider-owned dynamic tool ${qualifiedName} requires its exact call ID and qualified name`;
                reportProviderToolViolation(
                  callId || '(missing)',
                  qualifiedName,
                  message,
                  'unattested_provider_event',
                );
                throw new Error(message);
              }
              const payloadHash = providerToolPayloadHash(input);
              const announcement = providerToolStarts.get(callId);
              if (
                announcement &&
                (announcement.qualifiedName !== qualifiedName ||
                  announcement.payloadHash !== payloadHash)
              ) {
                const message = `Provider-owned tool ${callId} arguments do not match its announced call`;
                providerToolStarts.delete(callId);
                reportProviderToolViolation(
                  callId,
                  qualifiedName,
                  message,
                  'unattested_provider_event',
                );
                throw new Error(message);
              }
              if (providerToolAttestations.has(callId)) {
                const message = `Provider-owned tool call ID ${callId} was reused`;
                reportProviderToolViolation(
                  callId,
                  qualifiedName,
                  message,
                  'unattested_provider_event',
                );
                throw new Error(message);
              }
              const attestation: ProviderToolAttestation = {
                callId,
                qualifiedName,
                runtimeToolName,
                payloadHash,
                input,
                status: 'running',
                resultHashes: new Set(),
                startSeen: Boolean(announcement),
                acknowledged: false,
              };
              providerToolStarts.delete(callId);
              providerToolAttestations.set(callId, attestation);
              this.emit(
                'tool.started',
                {
                  id: callId,
                  name: qualifiedName,
                  providerOwned: true,
                  arguments: input,
                  attestation: { version: 1, payloadHash, status: 'running' },
                },
                {
                  sessionId: thread.sessionId,
                  threadId: thread.id,
                  runId: run.id,
                  correlationId: run.correlationId,
                },
              );
              try {
                const result = await tool.execute(input, metadata);
                attestation.status = 'succeeded';
                attestation.result = result;
                attestation.resultHashes.add(providerToolResultHash(result));
                await this.captureToolArtifacts(
                  run,
                  thread,
                  runtimeToolName,
                  input,
                  result,
                  callId,
                );
                return result;
              } catch (error) {
                attestation.status = 'failed';
                attestation.result = error instanceof Error ? error.message : String(error);
                attestation.resultHashes = providerToolFailureHashes(error);
                throw error;
              }
            },
          };
        },
      );
      const providerDynamicToolsByName = new Map(
        providerDynamicTools.map((tool) => [`${tool.namespace}.${tool.name}`, tool]),
      );
      const skillContext =
        this.options.skills?.promptContext(
          run.input,
          30_000,
          new Set(availableTools.map((tool) => tool.name)),
        ) ?? 'No skills are registered.';
      const manifest = buildCapabilityManifest({
        provider,
        model,
        root: this.runIdentity(run).workspaceRoot,
        permissions,
        tools: this.options.tools,
        dynamicTools: providerDynamicTools,
        verificationPolicy,
      });
      const context = this.options.store.getSession(thread.sessionId)?.context;
      const sessionContext = identity.origin === 'legacy-retained' ? undefined : context;
      const assemblePrompt = (summary: ReturnType<DatabaseStore['getThreadSummary']>) =>
        assembleSystemPrompt({
          identity: sessionIdentityPrompt(identity),
          approvalPolicy: this.options.store.sessionApprovalPolicy(thread.sessionId).mode,
          projectContext: sessionContext,
          memory: memoryContext,
          learning: this.options.knowledgeLearner?.status(),
          execution: this.executionStatus(run.id),
          skills: skillContext,
          transcriptSummary: transcriptSummaryContext(summary),
          manifest,
        });
      const maxContextTokens = Math.min(
        this.options.config.limits.maxContextTokens,
        this.options.config.provider.contextWindow,
      );
      const toolSchemaTokens = estimateToolSchemaTokens([
        ...providerTools,
        ...providerDynamicTools.map(({ namespace, name, description, parameters }) => ({
          namespace,
          name,
          description,
          parameters,
        })),
      ]);
      let checkpoint = this.options.store.getThreadSummary(thread.id);
      if (checkpoint)
        checkpoint = this.options.store.compactThreadThrough(
          thread.id,
          checkpoint.sourceEndMessageId,
          this.options.config.limits.maxContextSummaryTokens,
        );
      let prompt = assemblePrompt(checkpoint);
      let structuredContext = this.options.store.listStructuredMessagesThrough(
        thread.id,
        inputMessage.id,
      );
      const reservedTokens = (reserveSummary: boolean): number =>
        estimateMessageTokens({ role: 'system', content: prompt.systemPrompt }) +
        toolSchemaTokens +
        this.options.config.limits.contextResponseReserveTokens +
        (reserveSummary
          ? this.options.config.limits.maxContextSummaryTokens + summaryCheckpointEnvelopeTokens
          : 0);
      let selection = selectContextMessages(structuredContext, {
        maxTokens: maxContextTokens,
        currentMessageId: inputMessage.id,
        reservedTokens: reservedTokens(!checkpoint),
      });
      const initiallyDroppedMessageCount = selection.droppedMessageCount;
      while (selection.droppedMessageCount > 0) {
        const selectedIds = new Set(selection.messages.map((message) => message.id));
        const firstSelectedIndex = structuredContext.findIndex((message) =>
          selectedIds.has(message.id),
        );
        const compactThrough =
          firstSelectedIndex > 0 ? structuredContext[firstSelectedIndex - 1] : undefined;
        if (!compactThrough || compactThrough.id === inputMessage.id) break;
        checkpoint = this.options.store.compactThreadThrough(
          thread.id,
          compactThrough.id,
          this.options.config.limits.maxContextSummaryTokens,
        );
        this.emit(
          'context.compacted',
          {
            sourceMessageCount: checkpoint.sourceMessageCount,
            originalContextUnits: checkpoint.estimatedOriginalTokens,
            summaryContextUnits: checkpoint.estimatedSummaryTokens,
            version: checkpoint.version,
          },
          {
            sessionId: thread.sessionId,
            threadId: thread.id,
            runId: run.id,
            correlationId: run.correlationId,
          },
        );
        prompt = assemblePrompt(checkpoint);
        structuredContext = this.options.store.listStructuredMessagesThrough(
          thread.id,
          inputMessage.id,
        );
        selection = selectContextMessages(structuredContext, {
          maxTokens: maxContextTokens,
          currentMessageId: inputMessage.id,
          reservedTokens: reservedTokens(false),
        });
      }
      const selectedContextMessages = selection.messages;
      const canonicalContext = canonicalProviderMessages(
        prompt.systemPrompt,
        selectedContextMessages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
          ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
          ...(message.toolName ? { toolName: message.toolName } : {}),
          ...(message.id === inputMessage.id && images?.length ? { images } : {}),
        })),
      );
      const systemPrompt = canonicalContext.systemPrompt ?? '';
      let messages = canonicalContext.messages;
      const contextBuffer = new ContextBufferManager({
        maxTokens: maxContextTokens,
        responseReserveTokens: this.options.config.limits.contextResponseReserveTokens,
        maxSummaryTokens: this.options.config.limits.maxContextSummaryTokens,
        goalMessage: messages.filter((message) => message.role === 'user').at(-1),
        onCheckpoint: (active) => {
          this.options.store.storeMessageArtifact(
            inputMessage.id,
            `active_context:${active.version}`,
            { runId: run.id, ...active },
          );
          this.emit(
            'context.compacted',
            {
              phase: 'active',
              checkpointVersion: active.version,
              archivedCallCount: active.archivedCallCount,
              sourceSha256: active.sourceSha256,
              sourceMessageCount: active.newlyArchivedCallIds.length,
              summaryContextUnits: estimateMessageTokens({
                role: 'assistant',
                content: active.summary,
              }),
            },
            {
              sessionId: thread.sessionId,
              threadId: thread.id,
              runId: run.id,
              correlationId: run.correlationId,
            },
          );
        },
      });
      const assembledSystemPromptTokens = estimateMessageTokens({
        role: 'system',
        content: prompt.systemPrompt,
      });
      const selectedSystemMessageTokens = selectedContextMessages
        .filter((message) => message.role === 'system')
        .reduce((total, message) => total + estimateMessageTokens(message), 0);
      const systemPromptTokens = estimateMessageTokens({ role: 'system', content: systemPrompt });
      const canonicalReservedTokens =
        selection.reservedTokens - assembledSystemPromptTokens + systemPromptTokens;
      const canonicalEstimatedTokens =
        selection.estimatedTokens -
        assembledSystemPromptTokens -
        selectedSystemMessageTokens +
        systemPromptTokens;
      this.emit(
        'context.selected',
        {
          selectedMessageCount: selectedContextMessages.length,
          droppedMessageCount: initiallyDroppedMessageCount,
          compactedMessageCount: checkpoint?.sourceMessageCount ?? 0,
          estimatedContextUnits: canonicalEstimatedTokens,
          reservedContextUnits: canonicalReservedTokens,
          systemPromptContextUnits: systemPromptTokens,
          toolSchemaContextUnits: toolSchemaTokens,
          maxContextUnits: maxContextTokens,
          overBudget: canonicalEstimatedTokens > maxContextTokens,
        },
        {
          sessionId: thread.sessionId,
          threadId: thread.id,
          runId: run.id,
          correlationId: run.correlationId,
        },
      );
      this.emit(
        'capabilities.assembled',
        {
          provider: manifest.provider,
          model: manifest.model,
          ownsToolLoop: manifest.ownsToolLoop,
          toolCount: manifest.tools.length,
          tools: manifest.tools.map((tool) => ({
            name: tool.name,
            permission: tool.permission,
            governance: tool.governance,
          })),
          dynamicTools: manifest.dynamicTools,
          verificationPolicy,
        },
        {
          sessionId: thread.sessionId,
          threadId: thread.id,
          runId: run.id,
          correlationId: run.correlationId,
        },
      );
      this.emit(
        'prompt.assembled',
        {
          bytes: prompt.bytes,
          identitySnapshotId: identity.id,
          identityRevision: identity.revision,
          sections: prompt.sections.map((section) => section.name),
          provider: provider.name,
          model,
        },
        {
          sessionId: thread.sessionId,
          threadId: thread.id,
          runId: run.id,
          correlationId: run.correlationId,
        },
      );
      for (let turn = 0; turn <= this.options.config.limits.maxTurns; turn += 1) {
        const current = this.options.store.getRun(run.id);
        if (!current || current.cancelRequested) {
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
        if (controller.signal.aborted)
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('Run aborted');
        const finalizationGrace = turn === this.options.config.limits.maxTurns;
        if (finalizationGrace) {
          modelTurnBudgetExhausted = true;
          if (!finalizationRequested) {
            finalizationRequested = true;
            appendUserInstruction(messages, finalizationInstruction);
          }
        }
        const turnOutput = {
          text: '',
          calls: [] as Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
        };
        let turnOutputBytes = 0;
        let pendingDelta = '';
        let pendingDeltaBytes = 0;
        let deltaFlushTimer: ReturnType<typeof setTimeout> | undefined;
        let deltaFlushError: unknown;
        const eventContext = {
          sessionId: thread.sessionId,
          threadId: thread.id,
          runId: run.id,
          correlationId: run.correlationId,
        };
        const flushModelDelta = (): void => {
          if (deltaFlushTimer) {
            clearTimeout(deltaFlushTimer);
            deltaFlushTimer = undefined;
          }
          if (!pendingDelta) return;
          this.options.store.updateRun(run.id, { output: turnOutput.text });
          this.emit('model.delta', { text: pendingDelta, turn }, eventContext);
          pendingDelta = '';
          pendingDeltaBytes = 0;
        };
        const appendModelText = (text: string): void => {
          if (!text) return;
          const textBytes = Buffer.byteLength(text, 'utf8');
          turnOutput.text += text;
          turnOutputBytes += textBytes;
          generatedOutputBytes += textBytes;
          if (
            turnOutputBytes > this.options.config.limits.maxOutputBytes ||
            generatedOutputBytes > this.options.config.limits.maxOutputBytes
          )
            throw new Error('Run output limit exceeded');
          output = turnOutput.text;
          pendingDelta += text;
          pendingDeltaBytes += textBytes;
          if (pendingDeltaBytes >= modelDeltaBatchBytes) flushModelDelta();
          else
            deltaFlushTimer ??= setTimeout(() => {
              try {
                flushModelDelta();
              } catch (cause) {
                deltaFlushError = cause;
                controller.abort(cause);
              }
            }, modelDeltaBatchIntervalMs);
        };
        output = '';
        this.options.store.updateRun(run.id, { output });
        const toolsDisabled = finalizationGrace || finalizationRequested || toolBudgetExhausted;
        const turnProviderTools = toolsDisabled ? [] : providerTools;
        const turnDynamicTools = toolsDisabled ? [] : providerDynamicTools;
        messages = contextBuffer.prepare({
          systemPrompt,
          messages,
          tools: turnProviderTools,
          dynamicTools: turnDynamicTools,
        });
        const estimatedContextUnits = assertRequestContextBudget(
          { systemPrompt, messages, tools: turnProviderTools, dynamicTools: turnDynamicTools },
          maxContextTokens,
          this.options.config.limits.contextResponseReserveTokens,
        );
        this.emit(
          'context.selected',
          {
            phase: 'active',
            estimatedContextUnits,
            maxContextUnits: maxContextTokens,
            responseReserveTokens: this.options.config.limits.contextResponseReserveTokens,
            selectedMessageCount: messages.length,
            estimated: true,
          },
          eventContext,
        );
        this.emit(
          'model.started',
          {
            turn,
            provider: provider.name,
            model,
            tools: turnProviderTools.map((tool) => tool.name),
          },
          eventContext,
        );
        let providerStreamError: unknown;
        const modelTimeout = setTimeout(
          () =>
            controller.abort(
              new Error(
                `Model response timed out after ${this.options.config.limits.providerTimeoutMs}ms`,
              ),
            ),
          this.options.config.limits.providerTimeoutMs,
        );
        try {
          for await (const event of abortableStream(
            provider.stream({
              model,
              messages,
              tools: turnProviderTools,
              dynamicTools: turnDynamicTools,
              systemPrompt,
              reasoning: turnProviderTools.length > 0,
              conversationId: thread.id,
              signal: controller.signal,
            }),
            controller.signal,
            (error) => {
              console.warn('NUAAI model stream cleanup failed', {
                runId: run.id,
                provider: provider.name,
                error: redactText(error instanceof Error ? error.message : String(error)).slice(
                  0,
                  1024,
                ),
              });
            },
          )) {
            controller.signal.throwIfAborted();
            if (event.type === 'delta') appendModelText(event.text);
            else {
              flushModelDelta();
              if (event.type === 'tool_started') {
                if (!providerDynamicToolsByName.has(event.name)) {
                  reportProviderToolViolation(
                    event.id,
                    event.name,
                    `unadvertised provider-owned tool ${event.name}`,
                    'unadvertised_provider_event',
                  );
                  continue;
                }
                let payloadHash: string;
                try {
                  payloadHash = providerToolPayloadHash(event.arguments);
                } catch (error) {
                  reportProviderToolViolation(
                    event.id,
                    event.name,
                    `Provider-owned tool ${event.id} has unhashable arguments: ${error instanceof Error ? error.message : String(error)}`,
                    'unattested_provider_event',
                  );
                  continue;
                }
                const existingAttestation = providerToolAttestations.get(event.id);
                if (existingAttestation) {
                  if (
                    existingAttestation.qualifiedName === event.name &&
                    existingAttestation.payloadHash === payloadHash &&
                    !existingAttestation.startSeen
                  )
                    existingAttestation.startSeen = true;
                  else
                    reportProviderToolViolation(
                      event.id,
                      event.name,
                      `Provider-owned tool start ${event.id} does not match its callback attestation`,
                      'unattested_provider_event',
                    );
                  continue;
                }
                if (providerToolStarts.has(event.id)) {
                  reportProviderToolViolation(
                    event.id,
                    event.name,
                    `Provider-owned tool start ${event.id} was duplicated`,
                    'unattested_provider_event',
                  );
                  continue;
                }
                providerToolStarts.set(event.id, {
                  callId: event.id,
                  qualifiedName: event.name,
                  payloadHash,
                });
              } else if (event.type === 'tool_completed') {
                if (!providerDynamicToolsByName.has(event.name)) {
                  reportProviderToolViolation(
                    event.id,
                    event.name,
                    `unadvertised provider-owned tool ${event.name}`,
                    'unadvertised_provider_event',
                  );
                  continue;
                }
                const attestation = providerToolAttestations.get(event.id);
                if (!attestation) {
                  providerToolStarts.delete(event.id);
                  reportProviderToolViolation(
                    event.id,
                    event.name,
                    `Provider-owned tool completion ${event.id} is unattested because its execute callback did not run`,
                    'unattested_provider_event',
                  );
                  continue;
                }
                let payloadHash: string;
                let completedResultHash: string;
                try {
                  payloadHash = providerToolPayloadHash(event.arguments);
                  completedResultHash = providerToolResultHash(event.result);
                } catch (error) {
                  reportProviderToolViolation(
                    event.id,
                    event.name,
                    `Provider-owned tool completion ${event.id} could not be verified: ${error instanceof Error ? error.message : String(error)}`,
                    'unattested_provider_event',
                  );
                  continue;
                }
                const reportedStatus = event.isError ? 'failed' : 'succeeded';
                if (
                  attestation.acknowledged ||
                  !attestation.startSeen ||
                  attestation.status === 'running' ||
                  attestation.qualifiedName !== event.name ||
                  attestation.payloadHash !== payloadHash ||
                  attestation.status !== reportedStatus ||
                  !attestation.resultHashes.has(completedResultHash)
                ) {
                  reportProviderToolViolation(
                    event.id,
                    event.name,
                    `Provider-owned tool completion ${event.id} does not match its callback attestation`,
                    'unattested_provider_event',
                  );
                  continue;
                }
                attestation.acknowledged = true;
                toolActivity = true;
                if (attestation.status === 'succeeded')
                  verificationObservations.push({
                    name: attestation.runtimeToolName,
                    arguments: attestation.input,
                    result: attestation.result,
                  });
                const boundedResult = serializeBoundedToolResult(
                  attestation.result,
                  this.options.config.limits.maxToolResultBytes,
                );
                if (attestation.status === 'failed')
                  unresolvedToolFailures.push(`${event.name}: ${boundedResult.content}`);
                const toolMessage = this.addRunMessage(run, 'tool', boundedResult.content);
                this.options.store.storeMessageArtifact(toolMessage.id, 'tool_result', {
                  callId: event.id,
                  name: attestation.runtimeToolName,
                  result: boundedResult.value,
                  resultTruncated: boundedResult.truncated,
                });
                this.emit(
                  'tool.completed',
                  {
                    id: event.id,
                    name: event.name,
                    result: boundedResult.value,
                    resultBytes: boundedResult.bytes,
                    resultTruncated: boundedResult.truncated,
                    isError: event.isError,
                    providerOwned: true,
                    attestation: {
                      version: 1,
                      payloadHash: attestation.payloadHash,
                      resultHash: providerToolResultHash(attestation.result),
                      status: attestation.status,
                    },
                  },
                  eventContext,
                );
              } else if (event.type === 'tool_call')
                turnOutput.calls.push({
                  id: event.id,
                  name: event.name,
                  arguments: event.arguments,
                });
              else if (event.type === 'done' && !turnOutput.text && event.text)
                appendModelText(event.text);
              if (event.type === 'done' && event.usage) {
                const usageEvent = event as {
                  type: 'done';
                  text: string;
                  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
                };
                this.emit('model.usage', { turn, usage: usageEvent.usage }, eventContext);
              }
            }
          }
        } catch (cause) {
          providerStreamError = cause;
        } finally {
          clearTimeout(modelTimeout);
        }
        if (!providerStreamError && providerOwnsToolLoop) {
          for (const [callId, announcement] of providerToolStarts) {
            reportProviderToolViolation(
              callId,
              announcement.qualifiedName,
              `Provider-owned tool start ${callId} is unattested because its execute callback did not run`,
              'unattested_provider_event',
            );
            providerToolStarts.delete(callId);
          }
          for (const attestation of providerToolAttestations.values()) {
            if (attestation.acknowledged) continue;
            reportProviderToolViolation(
              attestation.callId,
              attestation.qualifiedName,
              `Provider-owned tool ${attestation.callId} callback result was not matched by a completion event`,
              'unattested_provider_event',
            );
            attestation.acknowledged = true;
          }
        }
        if (deltaFlushError) throw deltaFlushError;
        flushModelDelta();
        if (providerStreamError) throw providerStreamError;
        const currentAfterStream = this.options.store.getRun(run.id);
        if (currentAfterStream?.cancelRequested) {
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
        if (controller.signal.aborted)
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('Run aborted');
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
          if (providerOwnsToolLoop && unresolvedToolFailures.length) {
            output = `NUAAI could not verify completion because an action failed: ${unresolvedToolFailures.join('; ')}`;
            this.addRunMessage(run, 'assistant', output, provider.name, model);
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
          if (providerOwnsToolLoop) {
            output = turnOutput.text;
            if (
              !finalizationRequested &&
              !finalizationGrace &&
              (!output.trim() || looksLikeFutureIntent(output))
            ) {
              output = '';
              finalizationRequested = true;
              appendUserInstruction(messages, completionCorrectionInstruction);
              continue;
            }
            finalResponseAccepted = Boolean(output.trim()) && !looksLikeFutureIntent(output);
            break;
          }
          if (unresolvedToolFailures.length) {
            if (!recoveryRequested && !finalizationGrace) {
              recoveryRequested = true;
              messages.push({
                role: 'user',
                content:
                  'A previous tool call failed and remains unresolved. Retry the failed action with corrected arguments, or state plainly that the requested action could not be completed. Do not claim success and do not describe future work without performing it.',
              });
              continue;
            }
            output = `NUAAI could not verify completion because a tool failed: ${unresolvedToolFailures.join('; ')}`;
            this.addRunMessage(run, 'assistant', output, provider.name, model);
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
          if (
            toolActivity &&
            !finalizationRequested &&
            (!turnOutput.text.trim() || looksLikeFutureIntent(turnOutput.text))
          ) {
            output = '';
            finalizationRequested = true;
            messages.push({
              role: 'user',
              content:
                'Tool execution has ended. Provide the final answer now using only verified tool results. Do not describe future work, promise to run another action, or claim success without evidence. If the request was not completed, say so plainly.',
            });
            continue;
          }
          output = turnOutput.text;
          if (
            verificationRequiresEvidence(verificationPolicy) &&
            !toolActivity &&
            isCapabilityRefusal(output) &&
            availableTools.length
          ) {
            const hasCliExecution = availableTools.some((tool) =>
              ['host.command', 'workspace.command'].includes(tool.name),
            );
            if (
              !hasCliExecution &&
              /\b(?:cli|command|himalaya|shell|executable|terminal)\b/i.test(verificationInput)
            ) {
              rejectedCapabilityClaim = true;
              output =
                'NUAAI cannot execute a CLI command under the current permissions: no CLI execution tool is exposed. No command ran. Approval mode does not add execute permission to a read-only profile.';
              finalResponseAccepted = false;
            } else if (!capabilityCheckRequested) {
              capabilityCheckRequested = true;
              output = '';
              messages.push({
                role: 'user',
                content: availableTools.some((tool) => tool.name === 'host.command')
                  ? 'Check the actual available capability before declaring access unavailable. host.command executes installed host CLIs with literal argv; workspace.command is only the read-oriented probe tool. Use host.command for the requested CLI action, or use a relevant diagnostic tool to establish the precise blocker. Approval is handled by the daemon; do not substitute a promise or a generic refusal.'
                  : 'Use a relevant available diagnostic tool to establish the precise capability or permission limit before declaring missing access. Registered tool names alone do not prove the requested operation is supported. Report actual evidence and do not invent a successful action.',
              });
              continue;
            } else {
              rejectedCapabilityClaim = true;
              output =
                'NUAAI rejected an unverified capability claim after requesting a capability check. No action was executed. Tool registration alone does not prove the requested operation is supported; the model did not establish its precise blocker.';
              finalResponseAccepted = false;
            }
          } else if (verifiedRepositoryCount !== null && requestsExactRepositoryCount(run.input)) {
            output = String(verifiedRepositoryCount);
            finalResponseAccepted = true;
          } else finalResponseAccepted = Boolean(output.trim()) && !looksLikeFutureIntent(output);
          break;
        }
        if (finalizationGrace) {
          finalResponseAccepted =
            !unresolvedToolFailures.length &&
            Boolean(turnOutput.text.trim()) &&
            !looksLikeFutureIntent(turnOutput.text);
          break;
        }
        const normalizedCalls = turnOutput.calls.map((call) =>
          normalizeToolCall(call, providerTools),
        );
        messages.push({
          role: 'assistant',
          content: turnOutput.text,
          toolCalls: normalizedCalls,
        });
        const assistantToolMessage = this.addRunMessage(
          run,
          'assistant',
          turnOutput.text,
          provider.name,
          model,
        );
        this.options.store.storeMessageArtifact(assistantToolMessage.id, 'tool_calls', {
          calls: normalizedCalls,
        });
        for (const [index, call] of turnOutput.calls.entries()) {
          const normalizedCall = normalizedCalls[index];
          toolActivity = true;
          const emitToolStarted = (): void =>
            this.emit(
              'tool.started',
              {
                id: call.id,
                name: normalizedCall.name,
                ...(normalizedCall.requestedName
                  ? { requestedName: normalizedCall.requestedName }
                  : {}),
                arguments: normalizedCall.arguments,
              },
              {
                sessionId: thread.sessionId,
                threadId: thread.id,
                runId: run.id,
                correlationId: run.correlationId,
              },
            );
          try {
            if (!providerTools.some((tool) => tool.name === normalizedCall.name)) {
              const signature = `${normalizedCall.name}:${JSON.stringify(normalizedCall.arguments)}`;
              const attempts = (repeatedInvalidCalls.get(signature) ?? 0) + 1;
              repeatedInvalidCalls.set(signature, attempts);
              const message = `Tool ${normalizedCall.name} is not available for this request.`;
              unresolvedToolFailures.push(`${normalizedCall.name}: ${message}`);
              const toolContent = JSON.stringify({ error: message });
              const toolMessage = this.addRunMessage(run, 'tool', toolContent);
              this.options.store.storeMessageArtifact(toolMessage.id, 'tool_result', {
                callId: call.id,
                name: normalizedCall.name,
                result: { error: message },
              });
              messages.push({
                role: 'tool',
                content: toolContent,
                toolCallId: call.id,
                toolName: normalizedCall.name,
              });
              this.emit(
                'tool.failed',
                {
                  id: call.id,
                  name: normalizedCall.name,
                  ...(normalizedCall.requestedName
                    ? { requestedName: normalizedCall.requestedName }
                    : {}),
                  error: message,
                  reason: 'not_advertised',
                },
                {
                  sessionId: thread.sessionId,
                  threadId: thread.id,
                  runId: run.id,
                  correlationId: run.correlationId,
                },
              );
              if (attempts >= 2) {
                output = `NUAAI could not verify completion: ${message} Model repeated the same unavailable tool call.`;
                this.addRunMessage(run, 'assistant', output, provider.name, model);
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
              continue;
            }
            const toolContext = {
              root: this.runIdentity(run).workspaceRoot,
              permissions,
              budget: toolBudget,
              timeoutMs: this.options.config.limits.toolTimeoutMs,
              signal: controller.signal,
              threadId: thread.id,
              runId: run.id,
            };
            const registryToolName = registeredToolNames.has(normalizedCall.name)
              ? normalizedCall.name
              : registeredToolNames.has('mcp.execute')
                ? 'mcp.execute'
                : undefined;
            const registryInput =
              registryToolName === 'mcp.execute' && normalizedCall.name !== 'mcp.execute'
                ? { name: normalizedCall.name, arguments: normalizedCall.arguments }
                : normalizedCall.arguments;
            let result: unknown;
            if (registryToolName && this.options.tools.supportsAdmissionCallback === true) {
              result = await this.executeToolWithApproval(
                run,
                thread.sessionId,
                permissionSource,
                call.id,
                registryToolName,
                registryInput,
                permissions,
                false,
                {
                  budget: toolBudget,
                  timeoutMs: this.options.config.limits.toolTimeoutMs,
                  signal: controller.signal,
                },
                emitToolStarted,
              );
            } else if (registryToolName) {
              emitToolStarted();
              result = await this.options.tools.execute(
                registryToolName,
                registryInput,
                toolContext,
              );
            } else {
              emitToolStarted();
              result = await this.options.mcp?.execute(
                normalizedCall.name,
                normalizedCall.arguments,
                permissions,
                controller.signal,
              );
            }
            if (
              normalizedCall.name === 'github.repo.list' &&
              normalizedCall.arguments.mode === 'count' &&
              typeof result === 'object' &&
              result !== null &&
              'count' in result &&
              typeof result.count === 'number'
            )
              verifiedRepositoryCount = result.count;
            await this.captureToolArtifacts(
              run,
              thread,
              normalizedCall.name,
              normalizedCall.arguments,
              result,
              call.id,
            );
            const boundedResult = serializeBoundedToolResult(
              result,
              this.options.config.limits.maxToolResultBytes,
            );
            const toolContent = boundedResult.content;
            verificationObservations.push({
              name: normalizedCall.name,
              arguments: normalizedCall.arguments,
              result,
            });
            if (unresolvedToolFailures.length) unresolvedToolFailures.shift();
            const toolMessage = this.addRunMessage(run, 'tool', toolContent);
            this.options.store.storeMessageArtifact(toolMessage.id, 'tool_result', {
              callId: call.id,
              name: normalizedCall.name,
              result: boundedResult.value,
              resultTruncated: boundedResult.truncated,
            });
            messages.push({
              role: 'tool',
              content: toolContent,
              toolCallId: call.id,
              toolName: normalizedCall.name,
            });
            this.emit(
              'tool.completed',
              {
                id: call.id,
                name: normalizedCall.name,
                ...(normalizedCall.requestedName
                  ? { requestedName: normalizedCall.requestedName }
                  : {}),
                result: boundedResult.value,
                resultBytes: boundedResult.bytes,
                resultTruncated: boundedResult.truncated,
              },
              {
                sessionId: thread.sessionId,
                threadId: thread.id,
                runId: run.id,
                correlationId: run.correlationId,
              },
            );
            if (verifiedRepositoryCount !== null && requestsExactRepositoryCount(run.input)) {
              output = String(verifiedRepositoryCount);
              this.addRunMessage(run, 'assistant', output, provider.name, model);
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
              return;
            }
          } catch (error) {
            if (
              error instanceof ApprovalWaitInterruptedError ||
              error instanceof ApprovalDeniedError ||
              error instanceof ApprovalExpiredError ||
              ['failed', 'cancelled'].includes(this.options.store.getRun(run.id)?.status ?? '')
            )
              return;
            const message = error instanceof Error ? error.message : String(error);
            const budgetError = error instanceof ToolBudgetError ? error : undefined;
            if (budgetError) toolBudgetExhausted = true;
            const failureDetails = {
              error: message,
              ...(error instanceof ToolExecutionError
                ? {
                    failureCode: error.code,
                    executionState: error.executionState,
                    recovery: error.recovery,
                  }
                : {}),
            };
            const toolContent = JSON.stringify(failureDetails);
            const repairableRejection = isRepairableToolRejection(error);
            if (!budgetError && !repairableRejection)
              unresolvedToolFailures.push(`${normalizedCall.name}: ${message}`);
            const toolMessage = this.addRunMessage(run, 'tool', toolContent);
            this.options.store.storeMessageArtifact(toolMessage.id, 'tool_result', {
              callId: call.id,
              name: normalizedCall.name,
              result: failureDetails,
            });
            messages.push({
              role: 'tool',
              content: toolContent,
              toolCallId: call.id,
              toolName: normalizedCall.name,
            });
            this.emit(
              'tool.failed',
              {
                id: call.id,
                name: normalizedCall.name,
                ...(normalizedCall.requestedName
                  ? { requestedName: normalizedCall.requestedName }
                  : {}),
                error: message,
                ...(budgetError ? { reason: budgetError.reason } : {}),
                ...(repairableRejection ? { reason: 'repairable_rejection' } : {}),
                ...(error instanceof ToolExecutionError
                  ? {
                      executionState: error.executionState,
                      failureCode: error.code,
                      recovery: error.recovery,
                    }
                  : {}),
              },
              {
                sessionId: thread.sessionId,
                threadId: thread.id,
                runId: run.id,
                correlationId: run.correlationId,
              },
            );
            if (repairableRejection) {
              const signature = `repair:${normalizedCall.name}:${providerToolPayloadHash(normalizedCall.arguments)}`;
              const attempts = (repeatedInvalidCalls.get(signature) ?? 0) + 1;
              repeatedInvalidCalls.set(signature, attempts);
              if (attempts >= 3)
                throw new ToolExecutionError(
                  'Stopped after three repeated identical non-execution rejections. No schema-valid recovery was produced; inspect the recorded failure or ask for missing information instead of repeating the request.',
                  'TOOL_REPAIR_EXHAUSTED',
                  'not_executed',
                  'change_approach',
                );
            }
          }
        }
        if (toolBudgetExhausted && !toolBudgetNoticeAdded) {
          toolBudgetNoticeAdded = true;
          messages.push({
            role: 'user',
            content:
              'The run tool-call budget or weighted cost budget is exhausted. Do not request more tools. Provide the final answer now using only evidence already returned by completed calls, and state any remaining limitation plainly.',
          });
        }
      }
      if (!finalResponseAccepted) {
        const rejectedModelOutput = output.trim();
        output = rejectedCapabilityClaim
          ? output
          : modelTurnBudgetExhausted && toolActivity
            ? 'NUAAI could not verify completion: the tool-turn limit was reached before a final response.'
            : rejectedModelOutput && looksLikeFutureIntent(rejectedModelOutput)
              ? `NUAAI could not verify completion because the model returned only an unfinished action promise: ${rejectedModelOutput}`
              : rejectedModelOutput
                ? `NUAAI rejected the model response because it did not complete a verified action: ${rejectedModelOutput}`
                : toolActivity
                  ? 'NUAAI could not verify completion because the model produced no final response after tool execution.'
                  : 'NUAAI could not produce a non-empty final response.';
        this.addRunMessage(run, 'assistant', output, provider.name, model);
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
      if (
        !hasRelevantVerificationEvidence(
          verificationInput,
          verificationPolicy,
          verificationObservations,
        )
      ) {
        output = toolActivity
          ? 'NUAAI did not verify this request: relevant successful evidence for the requested facts or action is missing. Unrelated tool activity does not establish completion.'
          : 'NUAAI did not verify this request because no tool was executed. I will not report model-generated claims as facts.';
        this.addRunMessage(run, 'assistant', output, provider.name, model);
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
      this.addRunMessage(run, 'assistant', output, provider.name, model);
      if (
        this.options.skillLearner &&
        permissions.approved.has('write') &&
        permissions.capabilities.filesystem
      ) {
        try {
          const learned = await this.options.skillLearner.learnFromRun(run.input);
          if (learned)
            this.emit(
              'skill.learned',
              { name: learned.name, path: learned.path, triggers: learned.triggers },
              {
                sessionId: thread.sessionId,
                threadId: thread.id,
                runId: run.id,
                correlationId: run.correlationId,
              },
            );
        } catch (error) {
          this.emit(
            'skill.failed',
            { error: error instanceof Error ? error.message : String(error) },
            {
              sessionId: thread.sessionId,
              threadId: thread.id,
              runId: run.id,
              correlationId: run.correlationId,
            },
          );
        }
      }
      controller.signal.throwIfAborted();
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.options.store.getRun(run.id);
      if (error instanceof ApprovalWaitInterruptedError && current?.status === 'paused') return;
      if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) return;
      const status = current?.cancelRequested ? 'cancelled' : 'failed';
      const failureOutput =
        status === 'cancelled'
          ? current?.output || 'NUAAI run cancelled before completion.'
          : `NUAAI could not complete the run: ${message}`;
      this.addRunMessage(run, 'assistant', failureOutput, provider.name, run.model);
      this.options.store.updateRun(run.id, { status, output: failureOutput });
      this.emit(
        status === 'cancelled' ? 'run.cancelled' : 'run.failed',
        {
          error: message,
          ...(error instanceof ToolExecutionError
            ? {
                failureCode: error.code,
                executionState: error.executionState,
                recovery: error.recovery,
              }
            : {}),
        },
        { runId: run.id, threadId: run.threadId, correlationId: run.correlationId },
      );
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(run.id);
      if (writerClaimed)
        this.options.store.releaseRunWriter(run.threadId, run.id, this.writerOwnerId);
    }
  }
}
