export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ProviderImage {
  name?: string;
  mimeType?: string;
  data: string;
}

export interface ProviderMessage {
  role: MessageRole;
  content: string;
  images?: ProviderImage[];
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ProviderToolCall[];
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProviderTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderDynamicToolCallMetadata {
  callId: string;
  qualifiedName: string;
}

export interface ProviderDynamicTool extends ProviderTool {
  namespace: string;
  execute(
    input: Record<string, unknown>,
    metadata?: ProviderDynamicToolCallMetadata,
  ): Promise<unknown>;
}

export interface ProviderRequest {
  model: string;
  /** Canonical conversation rows. System instructions travel in systemPrompt. */
  messages: ProviderMessage[];
  /** Canonical system-instruction transport, serialized once by each adapter. */
  systemPrompt?: string;
  tools?: ProviderTool[];
  dynamicTools?: ProviderDynamicTool[];
  reasoning?: boolean;
  conversationId?: string;
  signal?: AbortSignal;
}

export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type ProviderStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: 'tool_started';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: 'tool_completed';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      result: unknown;
      isError: boolean;
    }
  | { type: 'done'; text: string; usage?: ProviderUsage };

export interface ProviderHealth {
  name: string;
  available: boolean;
  detail: string;
  models?: string[];
}

export interface ProviderAdapter {
  readonly name: string;
  readonly model: string;
  readonly ownsToolLoop?: boolean;
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  health(): Promise<ProviderHealth>;
  close?(): void | Promise<void>;
}
