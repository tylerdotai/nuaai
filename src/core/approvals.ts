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

export interface ApprovalPreviewField {
  label: string;
  value: string;
  format?: 'code';
}

export interface ApprovalPreviewV1 {
  version: 1;
  kind: string;
  summary: string;
  fields: ApprovalPreviewField[];
  context: {
    source: 'web' | 'matrix' | 'scheduler' | 'direct' | 'other';
    client: string;
    sessionId?: string;
  };
}

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
  preview: ApprovalPreviewV1;
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

export function approvalTarget(toolName: string, argumentsValue: Record<string, unknown>): string {
  const safeValue = (value: unknown): string | undefined => {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    return redactText(String(value)).slice(0, 120) || undefined;
  };
  const targetKeys: Record<string, string[]> = {
    'workspace.write': ['path'],
    'github.repo.list': ['owner'],
    'memory.forget': ['id'],
    'schedule.create': ['name'],
    'schedule.update': ['id', 'name'],
    'schedule.pause': ['id'],
    'schedule.resume': ['id'],
    'schedule.trigger': ['id'],
    'task.cancel': ['id'],
    'provider.switch': ['provider', 'model'],
    'mcp.execute': ['name'],
    'agent.dispatch': ['agent'],
  };
  if (toolName === 'computer.use') {
    const action = safeValue(argumentsValue.action)?.toLowerCase();
    return action && Object.hasOwn(computerFieldSpecs, action) ? action : '(unsupported action)';
  }
  for (const key of targetKeys[toolName] ?? []) {
    const value = safeValue(argumentsValue[key]);
    if (value) return value;
  }
  if (toolName === 'memory.store') return 'New durable memory';
  if (toolName === 'task.create') return 'New background task';
  const canonical = canonicalizeApprovalArguments(argumentsValue);
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${toolName} payload · ${Buffer.byteLength(canonical, 'utf8')} bytes · SHA-256 ${hash}`.slice(
    0,
    160,
  );
}

export function boundedApprovalPreview(value: unknown, maximum = 500): string {
  const safe = redactValue(value);
  const serialized = typeof safe === 'string' ? safe : JSON.stringify(safe);
  if (!serialized) return '';
  return serialized.length <= maximum ? serialized : `${serialized.slice(0, maximum - 1)}…`;
}

type PreviewFieldMode = 'code' | 'opaque';

const previewFieldSpecs: Record<string, Array<[string, string, PreviewFieldMode?]>> = {
  'workspace.command': [
    ['command', 'Command', 'opaque'],
    ['args', 'Arguments', 'opaque'],
  ],
  'github.repo.list': [
    ['owner', 'Owner'],
    ['mode', 'Mode'],
    ['limit', 'Limit'],
  ],
  'memory.store': [['content', 'Memory content', 'opaque']],
  'memory.forget': [['id', 'Memory ID']],
  'schedule.create': [
    ['name', 'Name'],
    ['type', 'Schedule type'],
    ['expression', 'Expression', 'code'],
    ['agentInput', 'Instruction', 'opaque'],
    ['enabled', 'Enabled'],
  ],
  'schedule.update': [
    ['id', 'Schedule ID'],
    ['name', 'Name'],
    ['type', 'Schedule type'],
    ['expression', 'Expression', 'code'],
    ['agentInput', 'Instruction', 'opaque'],
    ['enabled', 'Enabled'],
  ],
  'schedule.pause': [['id', 'Schedule ID']],
  'schedule.resume': [['id', 'Schedule ID']],
  'schedule.trigger': [['id', 'Schedule ID']],
  'task.create': [
    ['name', 'Name'],
    ['agentInput', 'Instruction', 'opaque'],
  ],
  'task.cancel': [['id', 'Task ID']],
  'provider.switch': [
    ['provider', 'Provider'],
    ['model', 'Model'],
  ],
  'mcp.execute': [['name', 'MCP tool']],
  'agent.dispatch': [
    ['agent', 'Agent'],
    ['prompt', 'Prompt', 'opaque'],
  ],
};

const computerFieldSpecs: Record<string, Array<[string, string, PreviewFieldMode?]>> = {
  capture: [
    ['app', 'Application'],
    ['pid', 'Process ID'],
    ['max_elements', 'Maximum elements'],
  ],
  list_apps: [],
  list_windows: [],
  click: [
    ['pid', 'Process ID'],
    ['element', 'Element'],
    ['coordinate', 'Coordinate'],
  ],
  double_click: [
    ['pid', 'Process ID'],
    ['element', 'Element'],
    ['coordinate', 'Coordinate'],
  ],
  right_click: [
    ['pid', 'Process ID'],
    ['element', 'Element'],
    ['coordinate', 'Coordinate'],
  ],
  middle_click: [
    ['pid', 'Process ID'],
    ['element', 'Element'],
    ['coordinate', 'Coordinate'],
  ],
  drag: [
    ['pid', 'Process ID'],
    ['from_coordinate', 'From coordinate'],
    ['to_coordinate', 'To coordinate'],
  ],
  scroll: [
    ['pid', 'Process ID'],
    ['element', 'Element'],
    ['coordinate', 'Coordinate'],
    ['direction', 'Direction'],
    ['amount', 'Amount'],
    ['delta_x', 'Horizontal delta'],
    ['delta_y', 'Vertical delta'],
  ],
  type: [
    ['pid', 'Process ID'],
    ['element', 'Element'],
    ['text', 'Text', 'opaque'],
  ],
  key: [
    ['pid', 'Process ID'],
    ['keys', 'Keys', 'code'],
  ],
  set_value: [
    ['pid', 'Process ID'],
    ['element', 'Element'],
    ['value', 'Value', 'opaque'],
  ],
};

const previewLabels = new Set([
  'Path',
  'Content size',
  'Content SHA-256',
  'Action',
  ...[...Object.values(previewFieldSpecs), ...Object.values(computerFieldSpecs)].flatMap((fields) =>
    fields.flatMap(([, label, mode]) =>
      mode === 'opaque' ? [`${label} size`, `${label} SHA-256`] : [label],
    ),
  ),
]);

function previewContext(
  permissionSource: string,
  sessionId?: string | null,
): ApprovalPreviewV1['context'] {
  const source = ['web', 'matrix', 'scheduler', 'direct'].includes(permissionSource)
    ? (permissionSource as ApprovalPreviewV1['context']['source'])
    : 'other';
  const clients: Record<ApprovalPreviewV1['context']['source'], string> = {
    web: 'Web client',
    matrix: 'Matrix bridge',
    scheduler: 'Scheduler',
    direct: 'Direct runtime client',
    other: 'Authenticated runtime client',
  };
  return {
    source,
    client: clients[source],
    ...(sessionId ? { sessionId: redactText(sessionId).slice(0, 160) } : {}),
  };
}

function previewValue(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const safe = redactValue(value);
  const serialized =
    typeof safe === 'string'
      ? safe
      : typeof safe === 'number' || typeof safe === 'boolean'
        ? String(safe)
        : Array.isArray(safe) &&
            safe.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry))
          ? `(${safe.map((entry) => String(entry)).join(', ')})`
          : undefined;
  if (serialized === undefined) return undefined;
  return serialized.length <= maximum
    ? serialized
    : `${serialized.slice(0, Math.max(0, maximum - 1))}…`;
}

function fieldsFromSpecs(
  argumentsValue: Record<string, unknown>,
  specs: Array<[string, string, PreviewFieldMode?]>,
): ApprovalPreviewField[] {
  return specs.flatMap(([key, label, mode]) => {
    const source = argumentsValue[key];
    if (source === undefined) return [];
    if (mode === 'opaque') {
      const serialized = typeof source === 'string' ? source : JSON.stringify(source);
      if (serialized === undefined) return [];
      return [
        { label: `${label} size`, value: `${Buffer.byteLength(serialized, 'utf8')} UTF-8 bytes` },
        {
          label: `${label} SHA-256`,
          value: createHash('sha256').update(serialized, 'utf8').digest('hex'),
        },
      ];
    }
    const value = previewValue(source, mode === 'code' ? 1_200 : 240);
    return value === undefined
      ? []
      : [{ label, value, ...(mode === 'code' ? { format: mode } : {}) }];
  });
}

export function buildApprovalPreview(
  toolName: string,
  argumentsValue: Record<string, unknown>,
  context: { permissionSource: string; sessionId?: string | null },
): ApprovalPreviewV1 {
  if (toolName === 'workspace.write') {
    const path = previewValue(argumentsValue.path, 240) ?? '(not specified)';
    const content = typeof argumentsValue.content === 'string' ? argumentsValue.content : '';
    return {
      version: 1,
      kind: toolName,
      summary: 'Write text file',
      fields: [
        { label: 'Path', value: path },
        { label: 'Content size', value: `${Buffer.byteLength(content, 'utf8')} UTF-8 bytes` },
        {
          label: 'Content SHA-256',
          value: createHash('sha256').update(content, 'utf8').digest('hex'),
        },
      ],
      context: previewContext(context.permissionSource, context.sessionId),
    };
  }
  if (toolName === 'computer.use') {
    const requestedAction =
      typeof argumentsValue.action === 'string' ? argumentsValue.action.trim().toLowerCase() : '';
    const action = Object.hasOwn(computerFieldSpecs, requestedAction)
      ? requestedAction
      : '(unsupported action)';
    const nested =
      argumentsValue.arguments &&
      typeof argumentsValue.arguments === 'object' &&
      !Array.isArray(argumentsValue.arguments)
        ? (argumentsValue.arguments as Record<string, unknown>)
        : {};
    return {
      version: 1,
      kind: toolName,
      summary: `Desktop action: ${action}`,
      fields: [
        { label: 'Action', value: action },
        ...fieldsFromSpecs(nested, computerFieldSpecs[action] ?? []),
      ],
      context: previewContext(context.permissionSource, context.sessionId),
    };
  }
  return {
    version: 1,
    kind: toolName,
    summary: `Run ${toolName}`,
    fields: fieldsFromSpecs(argumentsValue, previewFieldSpecs[toolName] ?? []),
    context: previewContext(context.permissionSource, context.sessionId),
  };
}

function storedApprovalPreview(row: ApprovalRequestRow): ApprovalPreviewV1 {
  try {
    const parsed = JSON.parse(row.argumentsPreview) as Partial<ApprovalPreviewV1>;
    if (
      parsed.version === 1 &&
      typeof parsed.kind === 'string' &&
      typeof parsed.summary === 'string' &&
      Array.isArray(parsed.fields) &&
      parsed.context &&
      typeof parsed.context === 'object'
    ) {
      const fields = parsed.fields.flatMap((field) => {
        if (
          !field ||
          typeof field !== 'object' ||
          typeof field.label !== 'string' ||
          !previewLabels.has(field.label) ||
          typeof field.value !== 'string'
        )
          return [];
        return [
          {
            label: field.label,
            value: previewValue(field.value, field.format === 'code' ? 1_200 : 240) ?? '',
            ...(field.format === 'code' ? { format: 'code' as const } : {}),
          },
        ];
      });
      return {
        version: 1,
        kind: parsed.kind === 'legacy' ? 'legacy' : row.toolName,
        summary:
          parsed.kind === 'legacy'
            ? 'Legacy approval preview unavailable'
            : row.toolName === 'workspace.write'
              ? 'Write text file'
              : row.toolName === 'computer.use'
                ? `Desktop action: ${fields.find((field) => field.label === 'Action')?.value ?? '(not specified)'}`
                : `Run ${row.toolName}`,
        fields,
        context: previewContext(row.permissionSource, row.sessionId),
      };
    }
  } catch {
    // Legacy rows contained a generic redacted JSON blob. Never re-expose it.
  }
  return {
    version: 1,
    kind: 'legacy',
    summary: `Run ${row.toolName}`,
    fields: [],
    context: previewContext(row.permissionSource, row.sessionId),
  };
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
    preview: storedApprovalPreview(row),
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
