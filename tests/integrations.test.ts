import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  MatrixBridge,
  extractMatrixMessages,
  formatMatrixBody,
  matrixHelpText,
  parseMatrixCommand,
} from '../src/integrations/matrix.js';
import { McpManager } from '../src/integrations/mcp.js';
import {
  BrowserAutomationClient,
  Crawl4AiClient,
  DuckDuckGoSearchClient,
  FlareSolverrClient,
  SearchStack,
  SearxngSearchClient,
  extractDuckDuckGoResults,
} from '../src/integrations/search.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('search integration', () => {
  it('normalizes local SearXNG JSON results', async () => {
    const client = new SearxngSearchClient('http://searxng.test', async () =>
      response({ results: [{ title: 'Result', url: 'https://example.com', content: 'Snippet' }] }),
    );

    await expect(client.search('nuaai')).resolves.toEqual([
      { title: 'Result', url: 'https://example.com', snippet: 'Snippet', source: 'searxng' },
    ]);
  });

  it('parses DuckDuckGo HTML fallback results', () => {
    const html =
      '<a class="result__a" href="https://example.com/a">A</a><a class="result__snippet">Snippet A</a>';
    expect(extractDuckDuckGoResults(html)).toEqual([
      { title: 'A', url: 'https://example.com/a', snippet: 'Snippet A', source: 'duckduckgo' },
    ]);
  });

  it('falls back from SearXNG to DuckDuckGo and from Crawl4AI to browser automation', async () => {
    const calls: string[] = [];
    const stack = new SearchStack({
      searxng: new SearxngSearchClient('http://searxng.test', async () => {
        calls.push('searxng');
        throw new Error('offline');
      }),
      duckduckgo: {
        search: async () => [
          { title: 'DDG', url: 'https://example.com', snippet: '', source: 'duckduckgo' },
        ],
      },
      crawl4ai: {
        crawl: async () => {
          calls.push('crawl4ai');
          throw new Error('offline');
        },
      },
      browser: {
        open: async () => {
          calls.push('playwright');
          return { url: 'https://example.com', title: 'Example', text: 'body' };
        },
      },
      flaresolverr: {
        scrape: async () => {
          calls.push('flaresolverr');
          return { url: 'https://example.com', title: 'Example', text: 'flare' };
        },
      },
    });

    await expect(stack.search('query')).resolves.toHaveLength(1);
    await expect(stack.fetch('https://example.com')).resolves.toMatchObject({ text: 'body' });
    expect(calls).toEqual(['searxng', 'crawl4ai', 'playwright']);
  });

  it('calls FlareSolverr through its /v1 API', async () => {
    const client = new FlareSolverrClient('http://flare.test', async (_url, init) => {
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('request.get');
      return response({
        solution: { status: 200, response: '<html>ok</html>', url: 'https://example.com' },
      });
    });

    await expect(client.scrape('https://example.com')).resolves.toEqual({
      url: 'https://example.com',
      title: '',
      text: '<html>ok</html>',
    });
  });

  it('validates browser URLs before launching automation', async () => {
    const client = new BrowserAutomationClient({
      launch: async () => {
        throw new Error('must not launch');
      },
    });
    await expect(client.open('file:///etc/passwd')).rejects.toThrow('http or https');
  });

  it('runs browser automation and closes the browser on success', async () => {
    const calls: string[] = [];
    const client = new BrowserAutomationClient({
      maxTextBytes: 4,
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {
            calls.push('goto');
          },
          title: async () => 'Example',
          locator: () => ({ innerText: async () => '123456' }),
        }),
        close: async () => {
          calls.push('close');
        },
      }),
    });

    await expect(client.open('https://example.com')).resolves.toEqual({
      url: 'https://example.com/',
      title: 'Example',
      text: '1234',
    });
    expect(calls).toEqual(['goto', 'close']);
  });

  it('handles local crawler, DuckDuckGo, and FlareSolverr response boundaries', async () => {
    const html = '<a class="result__a" href="https://example.com">A</a>';
    const duckduckgo = new DuckDuckGoSearchClient(async (_url, init) => {
      expect(init?.headers).toMatchObject({ accept: 'text/html' });
      return new Response(html, { status: 200 });
    });
    await expect(duckduckgo.search('query')).resolves.toHaveLength(1);

    const crawl4ai = new Crawl4AiClient('http://crawl.test', async () =>
      response({ results: [{ url: 'https://example.com', title: 'Page', markdown: 'text' }] }),
    );
    await expect(crawl4ai.crawl('https://example.com')).resolves.toMatchObject({ text: 'text' });
    await expect(crawl4ai.crawl('file:///etc/passwd')).rejects.toThrow('http or https');

    const alternateCrawl = new Crawl4AiClient('http://crawl.test', async () =>
      response({ results: [{ fit_markdown: 'fit' }] }),
    );
    await expect(alternateCrawl.crawl('https://example.com')).resolves.toMatchObject({
      text: 'fit',
    });
    const htmlCrawl = new Crawl4AiClient('http://crawl.test', async () =>
      response({ results: [{ cleaned_html: '<p>html</p>' }] }),
    );
    await expect(htmlCrawl.crawl('https://example.com')).resolves.toMatchObject({
      text: '<p>html</p>',
    });
    const emptyCrawl = new Crawl4AiClient('http://crawl.test', async () =>
      response({ results: [{}] }),
    );
    await expect(emptyCrawl.crawl('https://example.com')).rejects.toThrow('no page text');

    const flaresolverr = new FlareSolverrClient('http://flare.test', async () =>
      response({ solution: { response: 'flare' } }),
    );
    await expect(flaresolverr.crawl('https://example.com')).resolves.toMatchObject({
      text: 'flare',
    });
    const emptyFlare = new FlareSolverrClient('http://flare.test', async () =>
      response({ solution: { response: '' } }),
    );
    await expect(emptyFlare.scrape('https://example.com')).rejects.toThrow('no page response');
  });

  it('reports provider failures and supports disabled browser fallbacks', async () => {
    const stack = new SearchStack({
      searxng: {
        search: async () => {
          throw new Error('searxng down');
        },
      },
      duckduckgo: {
        search: async () => {
          throw new Error('ddg down');
        },
      },
      crawl4ai: {
        crawl: async () => {
          throw new Error('crawl down');
        },
      },
      browser: null,
      flaresolverr: {
        scrape: async () => ({ url: 'https://example.com', title: 'flare', text: 'ok' }),
      },
    });
    await expect(stack.search('query')).rejects.toThrow('Search providers failed');
    await expect(stack.open('https://example.com')).rejects.toThrow('disabled');
    await expect(stack.fetch('https://example.com')).resolves.toMatchObject({ title: 'flare' });
    const failedStack = new SearchStack({
      crawl4ai: {
        crawl: async () => {
          throw new Error('crawl down');
        },
      },
      browser: {
        open: async () => {
          throw new Error('browser down');
        },
      },
      flaresolverr: {
        scrape: async () => {
          throw new Error('flare down');
        },
      },
    });
    await expect(failedStack.fetch('https://example.com')).rejects.toThrow('Page providers failed');
  });
});

describe('Matrix integration', () => {
  it('parses slash commands and exposes the Matrix command help', () => {
    expect(parseMatrixCommand('/new   hardware audit')).toEqual({
      name: 'new',
      args: ['hardware', 'audit'],
    });
    expect(parseMatrixCommand('ordinary message')).toBeUndefined();
    expect(matrixHelpText()).toContain('/switch <session-id>');
    expect(matrixHelpText()).toContain('/status');
  });

  it('preserves inline and fenced code during Matrix HTML formatting', () => {
    const formatted = formatMatrixBody('Run `npm test`\n\n```ts\nconst ok = true;\n```');

    expect(formatted.formattedBody).toContain('<code>npm test</code>');
    expect(formatted.formattedBody).toContain('<pre><code>const ok = true;</code></pre>');
    expect(formatted.formattedBody).not.toContain('NUAAI_CODE');
  });

  it('extracts non-self m.room.message events from joined rooms', () => {
    expect(extractMatrixMessages(null, '@bot:example.org')).toEqual([]);
    const messages = extractMatrixMessages(
      {
        rooms: {
          join: {
            '!room:example.org': {
              timeline: {
                events: [
                  {
                    type: 'm.room.message',
                    sender: '@bot:example.org',
                    content: { msgtype: 'm.text', body: 'self' },
                  },
                  {
                    type: 'm.room.message',
                    sender: '@tyler:example.org',
                    event_id: '$1',
                    content: { msgtype: 'm.text', body: 'hello' },
                  },
                  {
                    type: 'm.room.message',
                    sender: '@tyler:example.org',
                    event_id: '$2',
                    content: {
                      msgtype: 'm.file',
                      body: '',
                      url: 'mxc://matrix.test/file',
                    },
                  },
                ],
              },
            },
          },
        },
      },
      '@bot:example.org',
    );

    expect(messages).toEqual([
      { roomId: '!room:example.org', eventId: '$1', sender: '@tyler:example.org', body: 'hello' },
      {
        roomId: '!room:example.org',
        eventId: '$2',
        sender: '@tyler:example.org',
        body: '[Attachment: attachment]',
        attachments: [{ name: 'attachment', mxcUrl: 'mxc://matrix.test/file' }],
      },
    ]);
    expect(
      extractMatrixMessages(
        {
          rooms: {
            join: {
              '!room:example.org': { timeline: { events: [null, {}, { type: 'm.room.member' }] } },
            },
          },
        },
        '@bot:example.org',
      ),
    ).toEqual([]);
  });

  it('sends Matrix messages using the authenticated client API', async () => {
    let payload: Record<string, unknown> | undefined;
    const bridge = new MatrixBridge(
      { homeserverUrl: 'https://matrix.test', accessToken: 'token', userId: '@bot:example.org' },
      async (_url, init) => {
        expect(init?.method).toBe('PUT');
        payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ event_id: '$sent' });
      },
    );

    await expect(bridge.sendText('!room:example.org', '**hello**\n- item')).resolves.toEqual({
      eventId: '$sent',
    });
    expect(payload).toMatchObject({
      msgtype: 'm.text',
      body: '**hello**\n- item',
      format: 'org.matrix.custom.html',
    });
    expect(payload?.formatted_body).toContain('<strong>hello</strong>');
    expect(payload?.formatted_body).toContain('<li>item</li>');
    expect(payload?.formatted_body).not.toContain('**hello**');
  });

  it('acknowledges received events and exposes typing state in Matrix', async () => {
    const requests: Array<{ url: string; method?: string; body: string }> = [];
    const bridge = new MatrixBridge(
      { homeserverUrl: 'https://matrix.test', accessToken: 'token', userId: '@bot:example.org' },
      async (url, init) => {
        requests.push({
          url: url.toString(),
          method: init?.method,
          body: String(init?.body ?? ''),
        });
        return response({});
      },
    );

    await bridge.sendReceipt('!room:example.org', '$received');
    await bridge.setTyping('!room:example.org', true);
    await bridge.setTyping('!room:example.org', false);
    await bridge.editText('!room:example.org', '$progress', '✅ workspace.command complete');

    expect(requests.slice(0, 3)).toEqual([
      {
        url: 'https://matrix.test/_matrix/client/v3/rooms/!room%3Aexample.org/receipt/m.read/%24received',
        method: 'POST',
        body: '{}',
      },
      {
        url: 'https://matrix.test/_matrix/client/v3/rooms/!room%3Aexample.org/typing/%40bot%3Aexample.org',
        method: 'PUT',
        body: '{"typing":true,"timeout":30000}',
      },
      {
        url: 'https://matrix.test/_matrix/client/v3/rooms/!room%3Aexample.org/typing/%40bot%3Aexample.org',
        method: 'PUT',
        body: '{"typing":false,"timeout":0}',
      },
    ]);
    expect(requests).toHaveLength(4);
    expect(requests[3]?.url).toMatch(
      /^https:\/\/matrix\.test\/\_matrix\/client\/v3\/rooms\/!room%3Aexample\.org\/send\/m\.room\.message\/[0-9a-f-]+$/,
    );
    expect(requests[3]).toMatchObject({
      method: 'PUT',
      body: expect.stringContaining(
        '"m.relates_to":{"rel_type":"m.replace","event_id":"$progress"}',
      ),
    });
  });

  it('downloads inbound Matrix media into a private attachment directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nuaai-matrix-'));
    let requestCount = 0;
    const bridge = new MatrixBridge(
      {
        homeserverUrl: 'https://matrix.test',
        accessToken: 'token',
        userId: '@bot:example.org',
        downloadDirectory: directory,
      },
      async () => {
        requestCount += 1;
        return requestCount === 1
          ? response({
              next_batch: 'next',
              rooms: {
                join: {
                  '!room:example.org': {
                    timeline: {
                      events: [
                        {
                          type: 'm.room.message',
                          sender: '@tyler:example.org',
                          event_id: '$file',
                          content: {
                            msgtype: 'm.file',
                            body: 'notes.pdf',
                            url: 'mxc://matrix.test/media-id',
                            info: { mimetype: 'application/pdf', size: 7 },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            })
          : new Response('payload', { status: 200 });
      },
    );

    const [message] = await bridge.syncOnce();
    const attachment = message.attachments?.[0];
    expect(attachment?.localPath).toBeTruthy();
    await expect(readFile(attachment?.localPath as string, 'utf8')).resolves.toBe('payload');
  });

  it('uploads MEDIA paths as Matrix file events after the text response', async () => {
    const calls: Array<{ method?: string; body?: string }> = [];
    const bridge = new MatrixBridge(
      {
        homeserverUrl: 'https://matrix.test',
        accessToken: 'token',
        userId: '@bot:example.org',
        workspaceRoot: process.cwd(),
      },
      async (_url, init) => {
        calls.push({ method: init?.method, body: String(init?.body ?? '') });
        return init?.method === 'POST'
          ? response({ content_uri: 'mxc://matrix.test/uploaded' })
          : response({ event_id: '$file-sent' });
      },
    );

    await bridge.sendOutput(
      '!room:example.org',
      `Here is the file.\nMEDIA: ${join(process.cwd(), 'AGENTS.md')}`,
    );
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[2].body ?? '{}')).toMatchObject({
      msgtype: 'm.file',
      body: 'AGENTS.md',
      url: 'mxc://matrix.test/uploaded',
    });
  });

  it('rejects oversized and malformed inbound Matrix media without writing files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nuaai-matrix-limit-'));
    let requestCount = 0;
    const bridge = new MatrixBridge(
      {
        homeserverUrl: 'https://matrix.test',
        accessToken: 'token',
        userId: '@bot:example.org',
        downloadDirectory: directory,
        maxAttachmentBytes: 5,
      },
      async () => {
        requestCount += 1;
        return requestCount === 1
          ? response({
              next_batch: 'next',
              rooms: {
                join: {
                  '!room:example.org': {
                    timeline: {
                      events: [
                        {
                          type: 'm.room.message',
                          sender: '@tyler:example.org',
                          event_id: '$large',
                          content: {
                            msgtype: 'm.file',
                            body: 'large.bin',
                            url: 'mxc://matrix.test/large',
                          },
                        },
                      ],
                    },
                  },
                },
              },
            })
          : new Response('payload', { status: 200, headers: { 'content-length': '6' } });
      },
    );
    const [large] = await bridge.syncOnce();
    expect(large.attachments?.[0]?.error).toContain('size limit');

    let malformedRequestCount = 0;
    const malformed = new MatrixBridge(
      {
        homeserverUrl: 'https://matrix.test',
        accessToken: 'token',
        userId: '@bot:example.org',
        downloadDirectory: directory,
      },
      async () => {
        malformedRequestCount += 1;
        return malformedRequestCount === 1
          ? response({
              next_batch: 'next',
              rooms: {
                join: {
                  '!room:example.org': {
                    timeline: {
                      events: [
                        {
                          type: 'm.room.message',
                          sender: '@tyler:example.org',
                          event_id: '$bad',
                          content: {
                            msgtype: 'm.file',
                            body: 'bad.bin',
                            url: 'https://not-mxc.example/file',
                          },
                        },
                      ],
                    },
                  },
                },
              },
            })
          : new Response('payload', { status: 200 });
      },
    );
    const [bad] = await malformed.syncOnce();
    expect(bad.attachments?.[0]?.error).toBe('Unsupported Matrix media URL');

    let bytesRequestCount = 0;
    const bytesLimited = new MatrixBridge(
      {
        homeserverUrl: 'https://matrix.test',
        accessToken: 'token',
        userId: '@bot:example.org',
        downloadDirectory: directory,
        maxAttachmentBytes: 3,
      },
      async () => {
        bytesRequestCount += 1;
        return bytesRequestCount === 1
          ? response({
              next_batch: 'next',
              rooms: {
                join: {
                  '!room:example.org': {
                    timeline: {
                      events: [
                        {
                          type: 'm.room.message',
                          sender: '@tyler:example.org',
                          event_id: '$bytes',
                          content: {
                            msgtype: 'm.file',
                            body: 'bytes.bin',
                            url: 'mxc://matrix.test/bytes',
                          },
                        },
                      ],
                    },
                  },
                },
              },
            })
          : new Response('payload', { status: 200 });
      },
    );
    const [bytes] = await bytesLimited.syncOnce();
    expect(bytes.attachments?.[0]?.error).toContain('size limit');
  });

  it('enforces outbound Matrix file boundaries and sends an empty-output notice', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nuaai-matrix-out-'));
    const file = join(directory, 'payload.txt');
    await writeFile(file, 'payload');
    const bridge = new MatrixBridge(
      {
        homeserverUrl: 'https://matrix.test',
        accessToken: 'token',
        userId: '@bot:example.org',
        workspaceRoot: directory,
        maxAttachmentBytes: 3,
      },
      async (_url, init) =>
        init?.method === 'POST'
          ? response({ content_uri: 'mxc://matrix.test/uploaded' })
          : response({ event_id: '$empty' }),
    );
    await expect(bridge.sendFile('!room:example.org', '/tmp/outside.txt')).rejects.toThrow(
      'inside the NUAAI workspace',
    );
    await expect(bridge.sendFile('!room:example.org', file)).rejects.toThrow('size limit');
    await expect(bridge.sendOutput('!room:example.org', '   ')).resolves.toBeUndefined();
  });

  it('joins invited rooms during sync', async () => {
    const methods: string[] = [];
    const bridge = new MatrixBridge(
      { homeserverUrl: 'https://matrix.test', accessToken: 'token', userId: '@bot:example.org' },
      async (_url, init) => {
        methods.push(init?.method ?? 'GET');
        return methods.length === 1
          ? response({ next_batch: 'next', rooms: { invite: { '!room:example.org': {} } } })
          : response({ room_id: '!room:example.org' });
      },
    );

    await bridge.syncOnce();
    expect(methods).toEqual(['GET', 'POST']);
  });

  it('resumes Matrix sync from a persisted token', async () => {
    let requestedUrl = '';
    let persistedSince = '';
    const bridge = new MatrixBridge(
      {
        homeserverUrl: 'https://matrix.test',
        accessToken: 'token',
        userId: '@bot:example.org',
        since: 'resume-token',
        onSince: (since) => {
          persistedSince = since;
        },
      },
      async (url) => {
        requestedUrl = url.toString();
        return response({ next_batch: 'next-token' });
      },
    );

    await bridge.syncOnce();
    expect(requestedUrl).toContain('since=resume-token');
    expect(persistedSince).toBe('next-token');
  });

  it('runs the polling lifecycle until the callback stops the bridge', async () => {
    const bridge = new MatrixBridge(
      { homeserverUrl: 'https://matrix.test', accessToken: 'token', userId: '@bot:example.org' },
      async () =>
        response({
          next_batch: 'next',
          rooms: {
            join: {
              '!room:example.org': {
                timeline: {
                  events: [
                    {
                      type: 'm.room.message',
                      sender: '@user:example.org',
                      event_id: '$message',
                      content: { msgtype: 'm.text', body: 'run' },
                    },
                  ],
                },
              },
            },
          },
        }),
    );

    await bridge.start(async (message) => {
      expect(message.body).toBe('run');
      bridge.stop();
    });
  });

  it('rejects empty messages and unsuccessful Matrix responses', async () => {
    const bridge = new MatrixBridge(
      { homeserverUrl: 'https://matrix.test', accessToken: 'token', userId: '@bot:example.org' },
      async () => response({}, 500),
    );
    await expect(bridge.sendText('!room:example.org', ' ')).rejects.toThrow('body is required');
    await expect(bridge.syncOnce()).rejects.toThrow('Matrix request failed: 500');
  });

  it('recovers from one temporary sync failure', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const bridge = new MatrixBridge(
      { homeserverUrl: 'https://matrix.test', accessToken: 'token', userId: '@bot:example.org' },
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary');
        return response({
          next_batch: 'next',
          rooms: {
            join: {
              '!room:example.org': {
                timeline: {
                  events: [
                    {
                      type: 'm.room.message',
                      sender: '@user:example.org',
                      event_id: '$message',
                      content: { msgtype: 'm.text', body: 'recovered' },
                    },
                  ],
                },
              },
            },
          },
        });
      },
    );
    const running = bridge.start(async () => bridge.stop());
    await vi.advanceTimersByTimeAsync(2_000);
    bridge.stop();
    await running;
    expect(attempts).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });
});

describe('MCP integration', () => {
  it('discovers and executes a namespaced stdio MCP tool', async () => {
    const serverScript =
      "process.stdin.on('data', data => { for (const line of data.toString().split('\\n')) { if (!line.trim()) continue; const request = JSON.parse(line); if (!request.id) continue; let result = {}; if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] }; else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] }; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n'); } });";
    const manager = new McpManager({
      enabled: true,
      servers: {
        local: {
          command: process.execPath,
          args: ['-e', serverScript],
          env: {},
          permission: 'read',
        },
      },
      computer: { enabled: false, command: 'cua-driver', args: ['mcp'] },
    });

    await manager.start();
    const permissions = {
      approved: new Set(['read'] as const),
      capabilities: { filesystem: true },
    };
    expect(manager.schemas(permissions).map((tool) => tool.name)).toEqual(['mcp.local.echo']);
    await expect(
      manager.execute('mcp.local.echo', { value: 'ok' }, permissions),
    ).resolves.toContain('ok');
    manager.stop();
  });

  it('returns structured content, surfaces remote errors, and preserves empty results', async () => {
    const serverScript =
      "process.stdout.write('not json\\n'); process.stdin.on('data', data => { for (const line of data.toString().split('\\n')) { if (!line.trim()) continue; const request = JSON.parse(line); if (!request.id) continue; let result = {}; if (request.method === 'tools/list') result = { tools: [{ name: 'structured' }, { name: 'failed' }, { name: 'empty' }] }; else if (request.method === 'tools/call' && request.params.name === 'structured') result = { structuredContent: { ok: true } }; else if (request.method === 'tools/call' && request.params.name === 'failed') result = { isError: true }; else if (request.method === 'tools/call') result = { content: [] }; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n'); } });";
    const manager = new McpManager({
      enabled: true,
      servers: {
        local: {
          command: process.execPath,
          args: ['-e', serverScript],
          env: {},
          permission: 'read',
        },
      },
      computer: { enabled: false, command: 'cua-driver', args: ['mcp'] },
    });
    await manager.start();
    const permissions = {
      approved: new Set(['read'] as const),
      capabilities: { filesystem: true },
    };
    expect(manager.schemas(permissions).map((tool) => tool.name)).toEqual([
      'mcp.local.structured',
      'mcp.local.failed',
      'mcp.local.empty',
    ]);
    await expect(manager.execute('mcp.local.structured', {}, permissions)).resolves.toEqual({
      ok: true,
    });
    await expect(manager.execute('mcp.local.failed', {}, permissions)).rejects.toThrow(
      'returned an error',
    );
    await expect(manager.execute('mcp.local.empty', {}, permissions)).resolves.toEqual({
      content: [],
    });
    await expect(manager.execute('mcp.local.unknown', {}, permissions)).rejects.toThrow(
      'Unknown MCP tool',
    );
    manager.stop();
  });

  it('auto-starts the configured computer MCP server and records request timeouts', async () => {
    const serverScript =
      "process.stdin.on('data', data => { for (const line of data.toString().split('\\n')) { if (!line.trim()) continue; const request = JSON.parse(line); if (!request.id) continue; const result = request.method === 'tools/list' ? { tools: [{ name: 'computer' }] } : { content: [{ type: 'text', text: 'ok' }] }; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n'); } });";
    const computer = new McpManager({
      enabled: true,
      servers: {},
      computer: { enabled: true, command: process.execPath, args: ['-e', serverScript] },
    });
    await computer.start();
    expect(computer.status()).toEqual({ servers: ['computer'], failures: {} });
    computer.stop();

    vi.useFakeTimers();
    try {
      const timeout = new McpManager({
        enabled: true,
        servers: {
          silent: {
            command: process.execPath,
            args: ['-e', 'process.stdin.resume()'],
            env: {},
            permission: 'read',
          },
        },
        computer: { enabled: false, command: 'cua-driver', args: ['mcp'] },
      });
      const starting = timeout.start();
      await vi.advanceTimersByTimeAsync(30_001);
      await starting;
      expect(timeout.status().failures.silent).toContain('timed out');
      timeout.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores malformed MCP output and surfaces JSON-RPC errors', async () => {
    const serverScript = `
      process.stdin.on('data', data => {
        for (const line of data.toString().split('\\n')) {
          if (!line.trim()) continue;
          const request = JSON.parse(line);
          if (!request.id) continue;
          process.stdout.write('\\nnot json\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', result: {} }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} }) + '\\n');
          if (request.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
          } else if (request.method === 'tools/list') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'rpc_error' }] } }) + '\\n');
          } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {} }) + '\\n');
          }
        }
      });
    `;
    const manager = new McpManager({
      enabled: true,
      servers: {
        noisy: {
          command: process.execPath,
          args: ['-e', serverScript],
          env: {},
          permission: 'read',
        },
      },
      computer: { enabled: false, command: 'cua-driver', args: ['mcp'] },
    });
    await manager.start();
    const permissions = {
      approved: new Set(['read'] as const),
      capabilities: { filesystem: true },
    };
    expect(manager.schemas(permissions)).toEqual([
      expect.objectContaining({ name: 'mcp.noisy.rpc_error' }),
    ]);
    await expect(manager.execute('mcp.noisy.rpc_error', {}, permissions)).rejects.toThrow(
      'MCP request failed',
    );
    manager.stop();
  });

  it('records unavailable servers, honors disabled mode, and enforces tool permissions', async () => {
    const disabled = new McpManager({
      enabled: false,
      servers: {},
      computer: { enabled: false, command: 'cua-driver', args: ['mcp'] },
    });
    await disabled.start();
    expect(disabled.status()).toEqual({ servers: [], failures: {} });

    const failing = new McpManager({
      enabled: true,
      servers: {
        missing: {
          command: '/definitely/not/a/real/mcp-server',
          args: [],
          env: {},
          permission: 'read',
        },
      },
      computer: { enabled: false, command: 'cua-driver', args: ['mcp'] },
    });
    await failing.start();
    expect(failing.status().failures.missing).toContain('ENOENT');

    const restricted = new McpManager({
      enabled: true,
      servers: {
        restricted: {
          command: process.execPath,
          args: [
            '-e',
            "process.stdin.on('data', data => { for (const line of data.toString().split('\\n')) { if (!line.trim()) continue; const request = JSON.parse(line); if (!request.id) continue; const result = request.method === 'tools/list' ? { tools: [{ name: 'run' }] } : { content: [{ type: 'text', text: 'ran' }] }; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n'); } });",
          ],
          env: {},
          permission: 'execute',
        },
      },
      computer: { enabled: false, command: 'cua-driver', args: ['mcp'] },
    });
    await restricted.start();
    const readOnly = { approved: new Set(['read'] as const), capabilities: { filesystem: true } };
    expect(restricted.schemas(readOnly)).toEqual([]);
    await expect(restricted.execute('mcp.restricted.run', {}, readOnly)).rejects.toThrow(
      'Permission required: execute',
    );
    failing.stop();
    restricted.stop();
  });
});
