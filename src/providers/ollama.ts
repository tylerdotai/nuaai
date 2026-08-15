import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderRequest,
  ProviderStreamEvent,
} from './types.js';

interface OllamaConfig {
  baseUrl: string;
  model: string;
  embeddingModel: string;
}

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
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model || this.model,
          messages: request.messages,
          stream: true,
          ...(request.tools?.length ? { tools: request.tools } : {}),
        }),
        signal: requestControl.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Ollama chat failed: ${response.status} ${await response.text()}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let output = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const value = JSON.parse(line) as {
            message?: {
              content?: string;
              tool_calls?: Array<{
                function?: { name?: string; arguments?: Record<string, unknown> };
              }>;
            };
            done?: boolean;
            error?: string;
          };
          if (value.error) throw new Error(`Ollama error: ${value.error}`);
          const content = value.message?.content ?? '';
          if (content) {
            output += content;
            yield { type: 'delta', text: content };
          }
          for (const tool of value.message?.tool_calls ?? []) {
            if (tool.function?.name)
              yield {
                type: 'tool_call',
                id: crypto.randomUUID(),
                name: tool.function.name,
                arguments: tool.function.arguments ?? {},
              };
          }
          if (value.done) yield { type: 'done', text: output };
        }
      }
      if (pending.trim()) {
        const value = JSON.parse(pending) as { message?: { content?: string }; done?: boolean };
        const content = value.message?.content ?? '';
        if (content) {
          output += content;
          yield { type: 'delta', text: content };
        }
        if (value.done) yield { type: 'done', text: output };
      }
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
