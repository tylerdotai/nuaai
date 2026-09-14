import { createHash } from 'node:crypto';

import { redactText, redactValue } from '../security/redaction.js';

export const approvalStatuses = [
  'pending',
  'approved',
  'denied',
  'expired',
  'executed',
  'failed',
] as const;

export type ApprovalStatus = (typeof approvalStatuses)[number];
export type ApprovalDecision = 'approved' | 'denied';
export type ApprovalPermission = 'read' | 'write' | 'execute';

export interface ApprovalRequestInput {
  id?: string;
  runId: string;
  threadId: string;
  sessionId?: string;
  toolCallId: string;
  toolName: string;
  canonicalArguments: string;
  payloadHash: string;
  requiredPermission: ApprovalPermission;
  permissionSource: string;
  risk: string;
  target: string;
  providerOwned: boolean;
  expiresAt: number;
}

export interface ApprovalExecutionView {
  startedAt?: number;
  completedAt?: number;
  resultHash?: string;
  resultPreview?: string;
  error?: string;
}

export interface ApprovalRequestRow {
  id: string;
  runId: string;
  threadId: string;
  sessionId: string | null;
  toolCallId: string;
  toolName: string;
  argumentsPreview: string;
  payloadHash: string;
  requiredPermission: ApprovalPermission;
  permissionSource: string;
  risk: string;
  target: string;
  providerOwned: boolean;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  executionStartedAt: number | null;
  executionCompletedAt: number | null;
  resultHash: string | null;
  resultPreview: string | null;
  executionError: string | null;
}

export interface ApprovalRequestView {
  id: string;
  runId: string;
  threadId: string;
  toolName: string;
  status: ApprovalStatus;
  payloadHash: string;
  target: string;
  risk: string;
  providerOwned: boolean;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  execution?: ApprovalExecutionView;
}

function canonicalValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error(`Approval arguments contain a non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value))
    return value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key], `${path}.${key}`)]),
    );
  }
  throw new Error(`Approval arguments contain an unsupported value at ${path}`);
}

export function canonicalizeApprovalArguments(argumentsValue: Record<string, unknown>): string {
  return JSON.stringify(canonicalValue(argumentsValue, '$'));
}

function framed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

export function approvalPayloadHash(
  runId: string,
  toolName: string,
  canonicalArguments: string,
): string {
  return createHash('sha256')
    .update(
      `nuaai-action-approval-v1\0${framed(runId)}${framed(toolName)}${framed(canonicalArguments)}`,
    )
    .digest('hex');
}

export function approvalTarget(argumentsValue: Record<string, unknown>): string {
  const safe = redactValue(argumentsValue) as Record<string, unknown>;
  for (const key of ['path', 'url', 'command', 'name', 'agent', 'id', 'query']) {
    const value = safe[key];
    if (value === undefined) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return redactText(text).slice(0, 160) || '(not specified)';
  }
  return '(not specified)';
}

export function boundedApprovalPreview(value: unknown, maximum = 500): string {
  const safe = redactValue(value);
  const serialized = typeof safe === 'string' ? safe : JSON.stringify(safe);
  if (!serialized) return '';
  return serialized.length <= maximum ? serialized : `${serialized.slice(0, maximum - 1)}…`;
}

export function resultHash(value: unknown): string {
  const serialized = JSON.stringify(redactValue(value)) ?? 'null';
  return createHash('sha256').update(serialized).digest('hex');
}

export function publicApprovalRequest(row: ApprovalRequestRow): ApprovalRequestView {
  const execution =
    row.executionStartedAt !== null ||
    row.executionCompletedAt !== null ||
    row.resultHash !== null ||
    row.resultPreview !== null ||
    row.executionError !== null
      ? {
          ...(row.executionStartedAt !== null ? { startedAt: row.executionStartedAt } : {}),
          ...(row.executionCompletedAt !== null ? { completedAt: row.executionCompletedAt } : {}),
          ...(row.resultHash !== null ? { resultHash: row.resultHash } : {}),
          ...(row.resultPreview !== null ? { resultPreview: row.resultPreview } : {}),
          ...(row.executionError !== null ? { error: row.executionError } : {}),
        }
      : undefined;
  return {
    id: row.id,
    runId: row.runId,
    threadId: row.threadId,
    toolName: row.toolName,
    status: row.status,
    payloadHash: row.payloadHash,
    target: row.target,
    risk: row.risk,
    providerOwned: row.providerOwned,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.decidedAt !== null ? { decidedAt: row.decidedAt } : {}),
    ...(execution ? { execution } : {}),
  };
}

export class ApprovalStateError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'approval_not_found'
      | 'approval_not_pending'
      | 'approval_expired'
      | 'approval_payload_mismatch'
      | 'approval_consumed',
  ) {
    super(message);
    this.name = 'ApprovalStateError';
  }
}

export class ApprovalDeniedError extends Error {
  constructor(readonly approvalId: string) {
    super(`Action approval ${approvalId} was denied`);
    this.name = 'ApprovalDeniedError';
  }
}

export class ApprovalExpiredError extends Error {
  constructor(readonly approvalId: string) {
    super(`Action approval ${approvalId} expired`);
    this.name = 'ApprovalExpiredError';
  }
}
