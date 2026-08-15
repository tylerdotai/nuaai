import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderMessage,
  ProviderRequest,
  ProviderStreamEvent,
} from './types.js';

interface OllamaConfig {
  baseUrl: string;
  model: string;
  embeddingModel: string;
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
  private readonly timeoutMs: number;

  constructor(config: OllamaConfig, timeoutMs = 180_000) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.model = config.model;
    this.embeddingModel = config.embeddingModel;
    this.timeoutMs = timeoutMs;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const requestControl = withAbort(request.signal, this.timeoutMs);
    const toolCalls = new Map<string, CollectedToolCall>();
    let fallbackIndex = 0;
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model || this.model,
          messages: request.messages.map(ollamaMessage),
          stream: true,
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
      const modern = await fetch(`${this.baseUrl}/api/embed`, {
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
      const legacy = await fetch(`${this.baseUrl}/api/embeddings`, {
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
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok)
        return { name: this.name, available: false, detail: `HTTP ${response.status}` };
      const value = (await response.json()) as { models?: Array<{ name?: string }> };
      return {
        name: this.name,
        available: true,
        detail: 'Ollama is reachable',
        models: value.models?.flatMap((model) => (model.name ? [model.name] : [])),
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
