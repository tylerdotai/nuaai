export interface Session {
  id: string;
  title: string;
  status: string;
  createdAt?: number;
}

export interface Thread {
  id: string;
  title: string;
  createdAt?: number;
}

export interface Message {
  id?: string;
  role: string;
  content: string;
  createdAt: number;
}

export type MessageViewStatus = 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface ActivityItem {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  target?: string;
  detail?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  arguments?: Record<string, unknown>;
}

export interface ActivityGroup {
  runId: string;
  status: MessageViewStatus;
  startedAt: number;
  completedAt?: number;
  items: ActivityItem[];
}

export interface CitationView {
  id: string;
  title: string;
  url: string;
}

export interface AttachmentView {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
}

export type RunArtifactKind =
  | 'file'
  | 'diff'
  | 'test-report'
  | 'screenshot'
  | 'citation'
  | 'deployment-receipt';

export type ArtifactView =
  | {
      type: 'artifact';
      id: string;
      runId: string;
      kind: Exclude<RunArtifactKind, 'citation'>;
      title: string;
      mimeType: string;
      byteSize: number;
      sha256: string;
      sourceTool: string;
      createdAt: number;
      downloadUrl?: string;
      externalUrl?: string;
    }
  | {
      type: 'unsupported';
      sourceKind: string;
      label: string;
    };

export interface ApprovalRequest {
  id: string;
  runId: string;
  threadId: string;
  toolName: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';
  payloadHash: string;
  target: string;
  risk: string;
  preview: {
    version: 1;
    kind: string;
    summary: string;
    fields: Array<{ label: string; value: string; format?: 'code' }>;
    context: {
      source: 'web' | 'matrix' | 'scheduler' | 'direct' | 'other';
      client: string;
      sessionId?: string;
    };
  };
  providerOwned: boolean;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  execution?: {
    startedAt?: number;
    completedAt?: number;
    resultHash?: string;
    resultPreview?: string;
    error?: string;
  };
}

export interface MessageView {
  id: string;
  runId?: string;
  role: 'user' | 'assistant';
  markdown: string;
  createdAt: number;
  provider?: { name: string; model: string };
  status: MessageViewStatus;
  activities: ActivityGroup[];
  error?: { message: string; code?: string; retryable: boolean };
  citations: CitationView[];
  attachments: AttachmentView[];
  artifacts: ArtifactView[];
}

export interface ThreadPresentation {
  version: 1;
  threadId: string;
  nextCursor: number;
  hasMore: boolean;
  messages: MessageView[];
}

export interface Schedule {
  id: string;
  name: string;
  type: string;
  expression: string;
  agentInput: string;
  enabled: boolean;
  nextRunAt: number | null;
  policy: {
    missedRun: string;
    maxAttempts: number;
    retryDelayMs: number;
    concurrencyLimit: number;
  };
}

export interface Task {
  id: string;
  kind: string;
  status: string;
  scheduleId: string | null;
  payload: Record<string, unknown>;
  updatedAt: number;
}

export interface MemoryRecord {
  id: string;
  content: string;
  createdAt: number;
  hasEmbedding: boolean;
}

export interface SkillRecord {
  name: string;
  description: string;
  version?: string;
  source?: string;
  triggers: string[];
  enabled?: boolean;
}

export interface PluginRecord {
  name: string;
  version: string;
  apiVersion: string;
  capabilities: string[];
  trusted: boolean;
  config?: Record<string, unknown>;
}

export interface PluginHealth {
  name: string;
  loaded: boolean;
  enabled: boolean;
  capabilities: string[];
  lastError?: string;
}

export interface ProviderHealth {
  name: string;
  available: boolean;
  detail: string;
  models?: string[];
}

export interface ActiveProvider {
  name: string;
  model: string;
}

export type PermissionProfile = 'read-only' | 'operator';
export type ViewId = 'conversation' | 'memory' | 'automations' | 'system';
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';
export type CommandId = 'new-session' | 'new-thread' | 'refresh' | 'focus-composer' | 'cancel-run';
