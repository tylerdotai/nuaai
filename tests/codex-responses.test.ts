import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { CodexResponsesProvider } from '../src/providers/codex-responses.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { ProviderMessage, ProviderStreamEvent } from '../src/providers/types.js';

function jwt(payload: Record<string, unknown>): string {
  return `test.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

async function authFixture(expiresAtSeconds = Math.floor(Date.now() / 1_000) + 3_600) {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-codex-responses-'));
  const authPath = join(root, 'auth.json');
  const modelsPath = join(root, 'models_cache.json');
  const accessToken = jwt({
    exp: expiresAtSeconds,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' },
  });
  await writeFile(
    authPath,
    JSON.stringify({ tokens: { access_token: accessToken, refresh_token: 'never-read-this' } }),
  );
  await writeFile(
    modelsPath,
    JSON.stringify({
      models: [
        { slug: 'gpt-visible', visibility: 'list' },
        { slug: 'gpt-hidden', visibility: 'hide' },
      ],
    }),
  );
  return { root, authPath, modelsPath, accessToken };
}

function sse(...events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect(
  provider: CodexResponsesProvider,
  messages: ProviderMessage[],
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.stream({
    model: 'gpt-visible',
    messages,
    systemPrompt: 'Use verified results only.',
    conversationId: 'thread-test',
    tools: [
      {
        name: 'workspace.list',
        description: 'List files',
        parameters: { type: 'object', properties: {} },
      },
    ],
  }))
    events.push(event);
  return events;
}

describe('Codex Responses transport', () => {
  it('routes the Codex registry entry through the NUAAI-owned tool loop', async () => {
    const registry = new ProviderRegistry({
      root: process.cwd(),
      providerName: 'codex',
      model: 'gpt-visible',
      baseUrl: 'http://127.0.0.1:11434',
      embeddingModel: 'embed-test',
      timeoutMs: 1_000,
      ollamaEnabled: false,
      codexEnabled: true,
    });
    expect(registry.get('codex')).toBeInstanceOf(CodexResponsesProvider);
    expect(registry.get('codex').ownsToolLoop).toBe(false);
    await registry.close();
  });

  it('streams text through the fixed Codex endpoint without leaking auth into the body', async () => {
    const fixture = await authFixture();
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return sse(
        { type: 'response.output_text.delta', delta: 'CODEX_' },
        { type: 'response.output_text.delta', delta: 'READY' },
        { type: 'response.completed', response: { status: 'completed', output: [] } },
      );
    }) as typeof fetch;
    const provider = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
      fetchFn,
    });

    await expect(
      collect(provider, [{ role: 'user', content: 'Synthetic request' }]),
    ).resolves.toEqual([
      { type: 'delta', text: 'CODEX_' },
      { type: 'delta', text: 'READY' },
      { type: 'done', text: '' },
    ]);
    expect(capturedUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(capturedInit?.redirect).toBe('error');
    expect(capturedInit?.headers).toMatchObject({
      Authorization: `Bearer ${fixture.accessToken}`,
      'ChatGPT-Account-ID': 'acct-test',
      originator: 'nuaai',
    });
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-visible',
      instructions: 'Use verified results only.',
      store: false,
      stream: true,
    });
    expect(JSON.stringify(body)).not.toContain(fixture.accessToken);
    expect(JSON.stringify(body)).not.toContain('never-read-this');
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        description: expect.stringContaining('workspace.list'),
        strict: false,
      }),
    ]);
  });

  it('maps provider-safe function names back to NUAAI tools and replays tool results', async () => {
    const fixture = await authFixture();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const tool = (body.tools as Array<{ name: string }>)[0];
      return bodies.length === 1
        ? sse(
            {
              type: 'response.output_item.done',
              item: {
                id: 'fc_item_1',
                type: 'function_call',
                call_id: 'call_1',
                name: tool.name,
                arguments: '{}',
              },
            },
            { type: 'response.completed', response: { status: 'completed', output: [] } },
          )
        : sse(
            { type: 'response.output_text.delta', delta: 'files inspected' },
            { type: 'response.completed', response: { status: 'completed', output: [] } },
          );
    }) as typeof fetch;
    const provider = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
      fetchFn,
    });

    await expect(collect(provider, [{ role: 'user', content: 'Inspect files' }])).resolves.toEqual([
      { type: 'tool_call', id: 'call_1', name: 'workspace.list', arguments: {} },
      { type: 'done', text: '' },
    ]);
    await expect(
      collect(provider, [
        { role: 'user', content: 'Inspect files' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'workspace.list', arguments: {} }],
        },
        {
          role: 'tool',
          content: '{"entries":["README.md"]}',
          toolCallId: 'call_1',
          toolName: 'workspace.list',
        },
      ]),
    ).resolves.toEqual([
      { type: 'delta', text: 'files inspected' },
      { type: 'done', text: '' },
    ]);
    expect(bodies[1]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', call_id: 'call_1' }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_1',
          output: '{"entries":["README.md"]}',
        }),
      ]),
    );
  });

  it('asks Codex to refresh expiring auth and then uses the rotated access token', async () => {
    const fixture = await authFixture(Math.floor(Date.now() / 1_000) + 30);
    const freshToken = jwt({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fresh' },
    });
    let refreshes = 0;
    let authorization = '';
    const provider = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
      refreshAuth: async () => {
        refreshes += 1;
        await writeFile(
          fixture.authPath,
          JSON.stringify({ tokens: { access_token: freshToken, refresh_token: 'still-private' } }),
        );
      },
      fetchFn: (async (_input: string | URL | Request, init?: RequestInit) => {
        authorization = String((init?.headers as Record<string, string>).Authorization);
        return sse(
          { type: 'response.output_text.delta', delta: 'fresh' },
          { type: 'response.completed', response: { status: 'completed', output: [] } },
        );
      }) as typeof fetch,
    });

    await collect(provider, [{ role: 'user', content: 'Use fresh auth' }]);
    expect(refreshes).toBe(1);
    expect(authorization).toBe(`Bearer ${freshToken}`);
  });

  it('refreshes through the Codex-owned account RPC with an explicit sanitized home', async () => {
    const fixture = await authFixture(Math.floor(Date.now() / 1_000) + 30);
    const freshToken = jwt({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-managed' },
    });
    const executable = join(fixture.root, 'codex-refresh-fake.mjs');
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  if (request.method === 'account/read') {
    if (request.params?.refreshToken !== true) {
      send({ id: request.id, error: { code: -32602, message: 'refreshToken required' } });
      return;
    }
    if (process.env.CODEX_HOME !== ${JSON.stringify(fixture.root)} || process.env.NUAAI_CODEX_SENTINEL) {
      send({ id: request.id, error: { code: -32602, message: 'unsafe environment' } });
      return;
    }
    writeFileSync(
      ${JSON.stringify(fixture.authPath)},
      JSON.stringify({ tokens: { access_token: ${JSON.stringify(freshToken)}, refresh_token: 'private' } }),
    );
    send({ id: request.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: false } });
  }
});
`,
    );
    await chmod(executable, 0o755);
    const previous = process.env.NUAAI_CODEX_SENTINEL;
    process.env.NUAAI_CODEX_SENTINEL = 'must-not-leak';
    let authorization = '';
    try {
      const provider = new CodexResponsesProvider({
        model: 'gpt-visible',
        executable,
        workspaceRoot: fixture.root,
        authPath: fixture.authPath,
        modelsPath: fixture.modelsPath,
        fetchFn: (async (_input: string | URL | Request, init?: RequestInit) => {
          authorization = String((init?.headers as Record<string, string>).Authorization);
          return sse(
            { type: 'response.output_text.delta', delta: 'managed' },
            { type: 'response.completed', response: { status: 'completed', output: [] } },
          );
        }) as typeof fetch,
      });
      await collect(provider, [{ role: 'user', content: 'Use Codex-managed refresh' }]);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'NUAAI_CODEX_SENTINEL');
      else process.env.NUAAI_CODEX_SENTINEL = previous;
    }
    expect(authorization).toBe(`Bearer ${freshToken}`);
  });

  it('supports images, system-message instructions, and completion-only output items', async () => {
    const fixture = await authFixture();
    await writeFile(
      fixture.authPath,
      JSON.stringify({ tokens: { access_token: 'opaque-access-token', refresh_token: 'private' } }),
    );
    let requestBody: Record<string, unknown> = {};
    let requestHeaders: Record<string, string> = {};
    const provider = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
      fetchFn: (async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requestHeaders = init?.headers as Record<string, string>;
        return sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              null,
              { type: 'message', content: 'not-an-array' },
              {
                type: 'message',
                content: [
                  null,
                  { type: 'output_text', text: 7 },
                  { type: 'output_text', text: 'fallback' },
                ],
              },
              {
                id: 'item-call',
                type: 'function_call',
                name: 'unmapped_tool',
                arguments: { value: 1 },
              },
            ],
          },
        });
      }) as typeof fetch,
    });
    const events: ProviderStreamEvent[] = [];
    for await (const event of provider.stream({
      model: '',
      messages: [
        { role: 'system', content: 'System instructions' },
        {
          role: 'user',
          content: 'Inspect images',
          images: [
            { mimeType: 'image/png', data: 'YWJj' },
            { data: 'data:image/webp;base64,ZGVm' },
          ],
        },
        { role: 'assistant', content: 'Prior answer' },
      ],
    }))
      events.push(event);

    expect(events).toEqual([
      { type: 'tool_call', id: 'item-call', name: 'unmapped_tool', arguments: { value: 1 } },
      { type: 'delta', text: 'fallback' },
      { type: 'done', text: '' },
    ]);
    expect(requestBody).not.toHaveProperty('tools');
    expect(requestBody).not.toHaveProperty('prompt_cache_key');
    expect(requestBody).toMatchObject({
      model: 'gpt-visible',
      instructions: 'System instructions',
    });
    expect(JSON.stringify(requestBody.input)).toContain('data:image/png;base64,YWJj');
    expect(JSON.stringify(requestBody.input)).toContain('data:image/webp;base64,ZGVm');
    expect(requestHeaders).not.toHaveProperty('ChatGPT-Account-ID');
  });

  it('fails closed on missing auth, invalid tool history, and malformed streams', async () => {
    const fixture = await authFixture();
    const missing = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: join(fixture.root, 'missing-auth.json'),
      modelsPath: join(fixture.root, 'missing-models.json'),
    });
    await expect(missing.health()).resolves.toMatchObject({
      available: false,
      detail: expect.stringContaining('codex login'),
    });
    await expect(missing.embed()).rejects.toThrow('does not provide embeddings');

    await writeFile(fixture.authPath, JSON.stringify({ tokens: {} }));
    const invalidAuth = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
    });
    await expect(collect(invalidAuth, [{ role: 'user', content: 'No auth' }])).rejects.toThrow(
      'codex login',
    );

    const valid = await authFixture();
    const neverFetch = vi.fn(async () => sse()) as typeof fetch;
    const noModel = new CodexResponsesProvider({
      model: '',
      authPath: valid.authPath,
      modelsPath: valid.modelsPath,
      fetchFn: neverFetch,
    });
    const noModelEvents = noModel.stream({ model: '', messages: [{ role: 'user', content: 'x' }] });
    await expect(noModelEvents[Symbol.asyncIterator]().next()).rejects.toThrow('requires a model');

    const missingCallId = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: valid.authPath,
      modelsPath: valid.modelsPath,
      fetchFn: neverFetch,
    });
    const missingIdEvents = missingCallId.stream({
      model: '',
      messages: [{ role: 'tool', content: '{}', toolName: 'workspace.list' }],
    });
    await expect(missingIdEvents[Symbol.asyncIterator]().next()).rejects.toThrow(
      'missing its call id',
    );

    for (const [body, expected] of [
      ['data: not-json\n\n', 'malformed stream data'],
      ['', 'empty stream'],
      ['data: [DONE]\n\n', 'without a terminal event'],
    ] as const) {
      const malformed = new CodexResponsesProvider({
        model: 'gpt-visible',
        authPath: valid.authPath,
        modelsPath: valid.modelsPath,
        fetchFn: (async () =>
          new Response(body || null, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })) as typeof fetch,
      });
      await expect(collect(malformed, [{ role: 'user', content: 'Malformed' }])).rejects.toThrow(
        expected,
      );
    }

    const noCallId = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: valid.authPath,
      modelsPath: valid.modelsPath,
      fetchFn: (async () =>
        sse({
          type: 'response.output_item.done',
          item: { type: 'function_call', name: 'tool', arguments: '{}' },
        })) as typeof fetch,
    });
    await expect(collect(noCallId, [{ role: 'user', content: 'Missing id' }])).rejects.toThrow(
      'without an id',
    );

    const badArguments = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: valid.authPath,
      modelsPath: valid.modelsPath,
      fetchFn: (async () =>
        sse({
          type: 'response.output_item.done',
          item: { type: 'function_call', call_id: 'call-bad', name: 'tool', arguments: '[]' },
        })) as typeof fetch,
    });
    await expect(collect(badArguments, [{ role: 'user', content: 'Bad call' }])).rejects.toThrow(
      'malformed tool arguments',
    );
  });

  it('classifies authentication, quota, terminal, abort, and timeout failures', async () => {
    const fixture = await authFixture();
    for (const [status, expected] of [
      [401, 'codex login'],
      [429, 'usage limit'],
    ] as const) {
      const provider = new CodexResponsesProvider({
        model: 'gpt-visible',
        authPath: fixture.authPath,
        modelsPath: fixture.modelsPath,
        fetchFn: (async () => new Response(null, { status })) as typeof fetch,
      });
      await expect(collect(provider, [{ role: 'user', content: 'HTTP failure' }])).rejects.toThrow(
        expected,
      );
    }

    for (const type of ['response.failed', 'response.incomplete'] as const) {
      const provider = new CodexResponsesProvider({
        model: 'gpt-visible',
        authPath: fixture.authPath,
        modelsPath: fixture.modelsPath,
        fetchFn: (async () => sse({ type })) as typeof fetch,
      });
      await expect(
        collect(provider, [{ role: 'user', content: 'Terminal failure' }]),
      ).rejects.toThrow(type === 'response.failed' ? 'failed' : 'incomplete');
    }

    const cancelled = new AbortController();
    cancelled.abort('cancelled');
    const aborted = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
      fetchFn: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return sse();
      }) as typeof fetch,
    });
    const abortedEvents = aborted.stream({
      model: 'gpt-visible',
      messages: [{ role: 'user', content: 'Cancel' }],
      signal: cancelled.signal,
    });
    await expect(abortedEvents[Symbol.asyncIterator]().next()).rejects.toThrow('request aborted');

    const timedOut = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
      timeoutMs: 5,
      fetchFn: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })) as typeof fetch,
    });
    await expect(collect(timedOut, [{ role: 'user', content: 'Timeout' }])).rejects.toThrow(
      'timed out',
    );
  });

  it('cancels the upstream SSE body after a terminal response', async () => {
    const fixture = await authFixture();
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: { status: 'completed', output: [] },
            })}\n\n`,
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const provider = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
      fetchFn: (async () => new Response(body)) as typeof fetch,
    });

    await collect(provider, [{ role: 'user', content: 'Complete once' }]);
    expect(cancelled).toBe(true);
  });

  it('cancels an unfinished HTTP error body before rejecting the request', async () => {
    const fixture = await authFixture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('upstream detail'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const provider = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
      fetchFn: (async () => new Response(body, { status: 502 })) as typeof fetch,
    });

    await expect(collect(provider, [{ role: 'user', content: 'Reject safely' }])).rejects.toThrow(
      'Codex Responses request failed (502)',
    );
    expect(cancelled).toBe(true);
  });

  it('reports visible cached models and rejects unsafe or incomplete provider responses', async () => {
    const fixture = await authFixture();
    const provider = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
      fetchFn: (async () =>
        new Response('upstream detail must not leak', { status: 502 })) as typeof fetch,
    });
    await expect(provider.health()).resolves.toMatchObject({
      name: 'codex',
      available: true,
      models: ['gpt-visible'],
    });
    await expect(collect(provider, [{ role: 'user', content: 'Fail safely' }])).rejects.toThrow(
      'Codex Responses request failed (502)',
    );

    const incomplete = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
      fetchFn: (async () =>
        sse({ type: 'response.output_text.delta', delta: 'partial' })) as typeof fetch,
    });
    await expect(
      collect(incomplete, [{ role: 'user', content: 'Do not accept partial' }]),
    ).rejects.toThrow('ended without a terminal event');

    const structuredError = new CodexResponsesProvider({
      model: 'gpt-visible',
      authPath: fixture.authPath,
      modelsPath: fixture.modelsPath,
      fetchFn: (async () =>
        sse({
          type: 'error',
          error: {
            code: 'invalid_request_error',
            message: 'Unsupported field prompt_cache_key',
          },
        })) as typeof fetch,
    });
    await expect(
      collect(structuredError, [{ role: 'user', content: 'Surface a safe error' }]),
    ).rejects.toThrow('invalid_request_error: Unsupported field prompt_cache_key');
  });
});
