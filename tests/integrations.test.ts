import { describe, expect, it, vi } from 'vitest';

import { MatrixBridge, extractMatrixMessages } from '../src/integrations/matrix.js';
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
    const bridge = new MatrixBridge(
      { homeserverUrl: 'https://matrix.test', accessToken: 'token', userId: '@bot:example.org' },
      async (_url, init) => {
        expect(init?.method).toBe('PUT');
        expect(String(init?.body)).toContain('hello');
        return response({ event_id: '$sent' });
      },
    );

    await expect(bridge.sendText('!room:example.org', 'hello')).resolves.toEqual({
      eventId: '$sent',
    });
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
