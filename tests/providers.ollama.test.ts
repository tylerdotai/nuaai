import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);

const { OllamaProvider } = await import('../src/providers/ollama.js');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProvider(
  overrides: Partial<ConstructorParameters<typeof OllamaProvider>[0]> = {},
): InstanceType<typeof OllamaProvider> {
  return new OllamaProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'llama-test',
    embeddingModel: 'nomic-embed',
    ...overrides,
  });
}

afterEach(() => {
  fetchMock.mockReset();
});

describe('OllamaProvider contract', () => {
  it('exposes the configured model and a stable provider name', () => {
    const provider = makeProvider({ model: 'llama-3.1' });
    expect(provider.name).toBe('ollama');
    expect(provider.model).toBe('llama-3.1');
  });

  it('normalizes a trailing slash in the base URL', () => {
    const provider = makeProvider({ baseUrl: 'http://127.0.0.1:11434/' });
    expect(provider.name).toBe('ollama');
  });

  it('reports healthy when the Ollama server returns its model list', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ name: 'llama-test' }] }));

    const provider = makeProvider();
    await expect(provider.health()).resolves.toEqual({
      name: 'ollama',
      available: true,
      detail: 'Ollama is reachable',
      models: ['llama-test'],
    });
  });

  it('reports unhealthy when the Ollama server returns a non-OK status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));

    const provider = makeProvider();
    await expect(provider.health()).resolves.toEqual({
      name: 'ollama',
      available: false,
      detail: 'HTTP 503',
    });
  });

  it('reports unhealthy when the Ollama server is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const provider = makeProvider();
    await expect(provider.health()).resolves.toEqual({
      name: 'ollama',
      available: false,
      detail: 'ECONNREFUSED',
    });
  });

  it('reports healthy against an OpenAI-compatible endpoint with model ids', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'gpt-test' }, { id: 'gpt-other' }] }),
    );

    const provider = makeProvider({ baseUrl: 'http://127.0.0.1:8080/v1' });
    await expect(provider.health()).resolves.toEqual({
      name: 'ollama',
      available: true,
      detail: 'OpenAI-compatible local endpoint is reachable',
      models: ['gpt-test', 'gpt-other'],
    });
  });

  it('reports unhealthy when the OpenAI-compatible endpoint returns a non-OK status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 502 }));

    const provider = makeProvider({ baseUrl: 'http://127.0.0.1:8080/v1' });
    await expect(provider.health()).resolves.toEqual({
      name: 'ollama',
      available: false,
      detail: 'HTTP 502',
    });
  });

  it('falls back from a 404 modern Ollama endpoint to the legacy /api/embeddings', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ embedding: [0.1, 0.2, 0.3] }));

    const provider = makeProvider();
    await expect(provider.embed('hello world')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects empty embeddings returned by the legacy endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ embedding: [] }));

    const provider = makeProvider();
    await expect(provider.embed('hello world')).rejects.toThrow(/empty embedding/);
  });

  it('rejects non-OK legacy embeddings', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
      .mockResolvedValueOnce(new Response('bad', { status: 500 }));

    const provider = makeProvider();
    await expect(provider.embed('hello world')).rejects.toThrow(/Ollama embedding failed/);
  });

  it('uses the OpenAI-compatible /v1/embeddings endpoint when configured', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ embedding: [0.5, 0.6] }] }));

    const provider = makeProvider({
      baseUrl: 'http://127.0.0.1:8080/v1',
      embeddingModel: 'text-embedding-3-small',
    });
    await expect(provider.embed('hello world')).resolves.toEqual([0.5, 0.6]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/v1/embeddings',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects non-OK OpenAI-compatible embeddings', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 500 }));

    const provider = makeProvider({
      baseUrl: 'http://127.0.0.1:8080/v1',
      embeddingModel: 'text-embedding-3-small',
    });
    await expect(provider.embed('hello world')).rejects.toThrow(
      /OpenAI-compatible embedding failed/,
    );
  });

  it('rejects empty OpenAI-compatible embeddings', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const provider = makeProvider({
      baseUrl: 'http://127.0.0.1:8080/v1',
      embeddingModel: 'text-embedding-3-small',
    });
    await expect(provider.embed('hello world')).rejects.toThrow(/no embedding/);
  });

  it('rejects when the modern /api/embed endpoint returns a non-OK, non-404 status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 500 }));

    const provider = makeProvider();
    await expect(provider.embed('hello world')).rejects.toThrow(/Ollama embedding failed/);
  });

  it('falls back when modern endpoint returns no embeddings array', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ embeddings: [] }))
      .mockResolvedValueOnce(jsonResponse({ embedding: [0.7, 0.8, 0.9] }));

    const provider = makeProvider();
    await expect(provider.embed('hello world')).resolves.toEqual([0.7, 0.8, 0.9]);
  });

  it('surfaces non-OK modern Ollama responses that are not 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 500 }));

    const provider = makeProvider();
    await expect(provider.embed('hello world')).rejects.toThrow(/Ollama embedding failed/);
  });
});
