import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderMessage,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderTool,
} from './types.js';

interface OllamaConfig {
  baseUrl: string;
  model: string;
  embeddingModel: string;
  embeddingBaseUrl?: string;
}

interface OllamaToolCall {
  id?: string;
  type?: string;
  function?: {
    index?: number;
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

interface OllamaMessage {
  content?: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatChunk {
  message?: OllamaMessage;
  done?: boolean;
  error?: string;
}

type CollectedToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
};

function withAbort(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Ollama request timed out')),
    timeoutMs,
  );
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

function ollamaMessage(message: ProviderMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.images?.length ? { images: message.images.map((image) => image.data) } : {}),
    ...(message.toolName ? { tool_name: message.toolName } : {}),
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call, index) => ({
            type: 'function',
            function: {
              index,
              name: call.name,
              arguments: call.arguments,
            },
          })),
        }
      : {}),
  };
}

function openAiToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function openAiMessage(message: ProviderMessage): Record<string, unknown> {
  const content = message.images?.length
    ? [
        { type: 'text', text: message.content },
        ...message.images.map((image) => ({
          type: 'image_url',
          image_url: {
            url: `data:${image.mimeType ?? 'application/octet-stream'};base64,${image.data}`,
          },
        })),
      ]
    : message.content;
  return {
    role: message.role,
    content,
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: openAiToolName(call.name),
              arguments: JSON.stringify(call.arguments),
            },
          })),
        }
      : {}),
  };
}

function openAiToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function textEncodedToolCall(
  content: string,
  tools: ProviderTool[] | undefined,
): { id: string; name: string; arguments: Record<string, unknown> } | undefined {
  const trimmed = content.trim();
  const fenced = /^```json\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const source = fenced?.[1] ?? (trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : '');
  if (!source || !tools?.length) return undefined;
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !['tool', 'arguments'].includes(key)) ||
      typeof record.tool !== 'string' ||
      !record.arguments ||
      typeof record.arguments !== 'object' ||
      Array.isArray(record.arguments)
    )
      return undefined;
    const advertised = tools.find(
      (tool) => tool.name === record.tool || openAiToolName(tool.name) === record.tool,
    );
    if (!advertised) return undefined;
    return {
      id: crypto.randomUUID(),
      name: advertised.name,
      arguments: record.arguments as Record<string, unknown>,
    };
  } catch {
    return undefined;
  }
}

function parseToolArguments(tool: CollectedToolCall): Record<string, unknown> {
  if (!tool.rawArguments) return tool.arguments;
  try {
    const parsed = JSON.parse(tool.rawArguments) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class OllamaProvider implements ProviderAdapter {
  readonly name = 'ollama';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly embeddingModel: string;
  private readonly embeddingBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly contextWindow: number;
  private readonly openAiCompatible: boolean;

  constructor(config: OllamaConfig, timeoutMs = 180_000, contextWindow = 262_144) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.model = config.model;
    this.embeddingModel = config.embeddingModel;
    this.embeddingBaseUrl = (config.embeddingBaseUrl ?? this.baseUrl).replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.contextWindow = contextWindow;
    this.openAiCompatible = this.baseUrl.endsWith('/v1');
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const requestControl = withAbort(request.signal, this.timeoutMs);
    const toolCalls = new Map<string, CollectedToolCall>();
    let fallbackIndex = 0;
    try {
      if (this.openAiCompatible) {
        const toolNameMap = new Map(
          (request.tools ?? []).map((tool) => [openAiToolName(tool.name), tool.name]),
        );
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: request.model || this.model,
            messages: [
              ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
              ...request.messages.map(openAiMessage),
            ],
            stream: false,
            ...(request.reasoning === undefined
              ? {}
              : { chat_template_kwargs: { enable_thinking: request.reasoning } }),
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((tool) => ({
                    type: 'function',
                    function: {
                      name: openAiToolName(tool.name),
                      description: tool.description,
                      parameters: tool.parameters,
                    },
                  })),
                }
              : {}),
          }),
          signal: requestControl.signal,
        });
        if (!response.ok)
          throw new Error(
            `OpenAI-compatible chat failed: ${response.status} ${await response.text()}`,
          );
        const value = (await response.json()) as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{
                id?: string;
                function?: { name?: string; arguments?: unknown };
              }>;
            };
          }>;
        };
        const message = value.choices?.[0]?.message;
        if (!message) throw new Error('OpenAI-compatible chat returned no message');
        const output = message.content ?? '';
        const nativeToolCalls = message.tool_calls ?? [];
        const fallbackToolCall = nativeToolCalls.length
          ? undefined
          : textEncodedToolCall(output, request.tools);
        const visibleOutput = fallbackToolCall ? '' : output;
        if (visibleOutput) yield { type: 'delta', text: visibleOutput };
        if (fallbackToolCall) yield { type: 'tool_call', ...fallbackToolCall };
        for (const call of nativeToolCalls) {
          const wireName = call.function?.name;
          if (!wireName) continue;
          yield {
            type: 'tool_call',
            id: call.id ?? crypto.randomUUID(),
            name: toolNameMap.get(wireName) ?? wireName,
            arguments: openAiToolArguments(call.function?.arguments),
          };
        }
        yield { type: 'done', text: visibleOutput };
        return;
      }
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model || this.model,
          messages: [
            ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
            ...request.messages.map(ollamaMessage),
          ],
          stream: true,
          options: { num_ctx: this.contextWindow },
          ...(request.reasoning === undefined ? {} : { think: request.reasoning }),
          ...(request.tools?.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }
            : {}),
        }),
        signal: requestControl.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(`Ollama chat failed: ${response.status} ${await response.text()}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let output = '';
      const collect = (calls: OllamaToolCall[]): void => {
        for (const call of calls) {
          const functionCall = call.function;
          if (!functionCall?.name) continue;
          const index = functionCall.index;
          const key =
            index === undefined ? (call.id ?? `fallback:${fallbackIndex++}`) : `index:${index}`;
          const existing = toolCalls.get(key) ?? {
            id: call.id ?? crypto.randomUUID(),
            name: functionCall.name,
            arguments: {},
            rawArguments: '',
          };
          existing.name = functionCall.name;
          if (typeof functionCall.arguments === 'string')
            existing.rawArguments += functionCall.arguments;
          else if (functionCall.arguments) existing.arguments = functionCall.arguments;
          toolCalls.set(key, existing);
        }
      };
      const consume = (line: string): string => {
        if (!line.trim()) return '';
        const value = JSON.parse(line) as OllamaChatChunk;
        if (value.error) throw new Error(`Ollama error: ${value.error}`);
        const content = value.message?.content ?? '';
        if (content) {
          output += content;
        }
        collect(value.message?.tool_calls ?? []);
        return content;
      };
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const content = consume(line);
          if (content) yield { type: 'delta', text: content };
        }
      }
      pending += decoder.decode();
      if (pending.trim()) {
        const content = consume(pending);
        if (content) yield { type: 'delta', text: content };
      }
      for (const tool of toolCalls.values())
        yield {
          type: 'tool_call',
          id: tool.id,
          name: tool.name,
          arguments: parseToolArguments(tool),
        };
      yield { type: 'done', text: output };
    } finally {
      requestControl.cleanup();
    }
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const requestControl = withAbort(signal, this.timeoutMs);
    try {
      if (this.embeddingBaseUrl.endsWith('/v1')) {
        const response = await fetch(`${this.embeddingBaseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.embeddingModel, input: [text] }),
          signal: requestControl.signal,
        });
        if (!response.ok)
          throw new Error(
            `OpenAI-compatible embedding failed: ${response.status} ${await response.text()}`,
          );
        const value = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
        const embedding = value.data?.[0]?.embedding;
        if (!embedding?.length) throw new Error('OpenAI-compatible endpoint returned no embedding');
        return embedding;
      }
      const modern = await fetch(`${this.embeddingBaseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.embeddingModel, input: [text] }),
        signal: requestControl.signal,
      });
      if (modern.ok) {
        const value = (await modern.json()) as { embeddings?: number[][] };
        const embedding = value.embeddings?.[0];
        if (embedding?.length) return embedding;
      } else if (modern.status !== 404) {
        throw new Error(`Ollama embedding failed: ${modern.status} ${await modern.text()}`);
      }
      const legacy = await fetch(`${this.embeddingBaseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.embeddingModel, prompt: text }),
        signal: requestControl.signal,
      });
      if (!legacy.ok)
        throw new Error(`Ollama embedding failed: ${legacy.status} ${await legacy.text()}`);
      const value = (await legacy.json()) as { embedding?: number[] };
      if (!value.embedding?.length) throw new Error('Ollama returned an empty embedding');
      return value.embedding;
    } finally {
      requestControl.cleanup();
    }
  }

  async health(): Promise<ProviderHealth> {
    try {
      const response = await fetch(
        this.openAiCompatible ? `${this.baseUrl}/models` : `${this.baseUrl}/api/tags`,
      );
      if (!response.ok)
        return { name: this.name, available: false, detail: `HTTP ${response.status}` };
      const value = (await response.json()) as {
        models?: Array<{ name?: string }>;
        data?: Array<{ id?: string }>;
      };
      return {
        name: this.name,
        available: true,
        detail: this.openAiCompatible
          ? 'OpenAI-compatible local endpoint is reachable'
          : 'Ollama is reachable',
        models: this.openAiCompatible
          ? value.data?.flatMap((model) => (model.id ? [model.id] : []))
          : value.models?.flatMap((model) => (model.name ? [model.name] : [])),
      };
    } catch (error) {
      return {
        name: this.name,
        available: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
