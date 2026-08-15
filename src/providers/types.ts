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

export interface ProviderRequest {
  model: string;
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  signal?: AbortSignal;
}

export type ProviderStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'done'; text: string };

export interface ProviderHealth {
  name: string;
  available: boolean;
  detail: string;
  models?: string[];
}

export interface ProviderAdapter {
  readonly name: string;
  readonly model: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  health(): Promise<ProviderHealth>;
}
