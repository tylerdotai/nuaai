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

export interface ArtifactView {
  type: 'unsupported';
  sourceKind: string;
  label: string;
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
  version: string;
  source: string;
}

export interface PluginRecord {
  name: string;
  version: string;
  apiVersion: string;
  capabilities: string[];
  trusted: boolean;
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
