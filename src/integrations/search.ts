export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: 'searxng' | 'duckduckgo';
}

export interface PageResult {
  url: string;
  title: string;
  text: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function cleanHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Browser URL must be a valid http or https URL');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Browser URL must use http or https');
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`HTTP request failed: ${response.status}`);
  return response.json();
}

export class SearxngSearchClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '0');
    const value = (await readJson(
      await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) }),
    )) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (value.results ?? []).slice(0, limit).flatMap((result) =>
      result.title && result.url
        ? [
            {
              title: result.title,
              url: result.url,
              snippet: result.content ?? '',
              source: 'searxng' as const,
            },
          ]
        : [],
    );
  }
}

export function extractDuckDuckGoResults(html: string): SearchResult[] {
  const anchors = [
    ...html.matchAll(
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ];
  const snippets = [...html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//gi)];
  return anchors.map((match, index) => ({
    title: cleanHtml(match[2]),
    url: match[1].replace(/&amp;/g, '&'),
    snippet: cleanHtml(snippets[index]?.[1] ?? ''),
    source: 'duckduckgo' as const,
  }));
}

export class DuckDuckGoSearchClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);
    const response = await this.fetchImpl(url, {
      headers: { accept: 'text/html', 'user-agent': 'nuaai/0.1 (+local agent)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`DuckDuckGo request failed: ${response.status}`);
    return extractDuckDuckGoResults(await response.text()).slice(0, limit);
  }
}

export class Crawl4AiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async crawl(url: string): Promise<PageResult> {
    ensureHttpUrl(url);
    const response = await this.fetchImpl(new URL('/crawl', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: [url], bypass_cache: true, word_count_threshold: 10 }),
      signal: AbortSignal.timeout(60_000),
    });
    const value = (await readJson(response)) as {
      results?: Array<{
        url?: string;
        title?: string;
        markdown?: string;
        fit_markdown?: string;
        cleaned_html?: string;
      }>;
      url?: string;
      title?: string;
      markdown?: string;
      fit_markdown?: string;
      cleaned_html?: string;
    };
    const result = value.results?.[0] ?? value;
    const text = result.markdown ?? result.fit_markdown ?? result.cleaned_html ?? '';
    if (!text) throw new Error('Crawl4AI returned no page text');
    return { url: result.url ?? url, title: result.title ?? '', text };
  }
}

export interface BrowserSession {
  newPage(): Promise<{
    goto(
      url: string,
      options: { waitUntil: 'domcontentloaded'; timeout: number },
    ): Promise<unknown>;
    title(): Promise<string>;
    locator(selector: string): { innerText(options: { timeout: number }): Promise<string> };
  }>;
  close(): Promise<void>;
}

export class BrowserAutomationClient {
  constructor(
    private readonly options: {
      launch?: () => Promise<BrowserSession>;
      timeoutMs?: number;
      maxTextBytes?: number;
    } = {},
  ) {}

  async crawl(url: string): Promise<PageResult> {
    return this.open(url);
  }

  async open(rawUrl: string): Promise<PageResult> {
    const url = ensureHttpUrl(rawUrl).toString();
    const browser = await (
      this.options.launch ??
      (async () => {
        const playwrightPackage = 'playwright';
        const { chromium } = (await import(playwrightPackage)) as typeof import('playwright');
        return chromium.launch({ headless: true });
      })
    )();
    try {
      const page = await browser.newPage();
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.options.timeoutMs ?? 30_000,
      });
      const text = await page
        .locator('body')
        .innerText({ timeout: this.options.timeoutMs ?? 30_000 });
      return {
        url,
        title: await page.title(),
        text: text.slice(0, this.options.maxTextBytes ?? 1_000_000),
      };
    } finally {
      await browser.close();
    }
  }
}

export class FlareSolverrClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async crawl(url: string): Promise<PageResult> {
    return this.scrape(url);
  }

  async scrape(url: string): Promise<PageResult> {
    ensureHttpUrl(url);
    const response = await this.fetchImpl(new URL('/v1', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60_000 }),
      signal: AbortSignal.timeout(75_000),
    });
    const value = (await readJson(response)) as {
      solution?: { url?: string; response?: string; title?: string };
    };
    const solution = value.solution;
    if (!solution?.response) throw new Error('FlareSolverr returned no page response');
    return { url: solution.url ?? url, title: solution.title ?? '', text: solution.response };
  }
}

interface SearchClient {
  search(query: string, limit?: number): Promise<SearchResult[]>;
}
interface PageClient {
  crawl(url: string): Promise<PageResult>;
}
interface BrowserClient {
  open(url: string): Promise<PageResult>;
}
interface FlareClient {
  scrape(url: string): Promise<PageResult>;
}

export class SearchStack {
  private readonly searxng: SearchClient;
  private readonly duckduckgo: SearchClient;
  private readonly crawl4ai: PageClient;
  private readonly browser?: BrowserClient;
  private readonly flaresolverr?: FlareClient;

  constructor(
    options: {
      searxng?: SearchClient;
      duckduckgo?: SearchClient;
      crawl4ai?: PageClient;
      browser?: BrowserClient | null;
      flaresolverr?: FlareClient | null;
    } = {},
  ) {
    this.searxng = options.searxng ?? new SearxngSearchClient('http://127.0.0.1:40102');
    this.duckduckgo = options.duckduckgo ?? new DuckDuckGoSearchClient();
    this.crawl4ai = options.crawl4ai ?? new Crawl4AiClient('http://127.0.0.1:40103');
    this.browser =
      options.browser === null ? undefined : (options.browser ?? new BrowserAutomationClient());
    this.flaresolverr =
      options.flaresolverr === null
        ? undefined
        : (options.flaresolverr ?? new FlareSolverrClient('http://127.0.0.1:40104'));
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    try {
      return await this.searxng.search(query, limit);
    } catch (firstError) {
      try {
        return await this.duckduckgo.search(query, limit);
      } catch (secondError) {
        throw new Error(
          `Search providers failed: ${firstError instanceof Error ? firstError.message : String(firstError)}; ${secondError instanceof Error ? secondError.message : String(secondError)}`,
        );
      }
    }
  }

  async open(url: string): Promise<PageResult> {
    if (!this.browser) throw new Error('Browser automation is disabled');
    return this.browser.open(url);
  }

  async fetch(url: string): Promise<PageResult> {
    try {
      return await this.crawl4ai.crawl(url);
    } catch (firstError) {
      try {
        if (!this.browser) throw new Error('Browser automation is disabled');
        return await this.browser.open(url);
      } catch (secondError) {
        try {
          if (!this.flaresolverr) throw new Error('FlareSolverr is disabled');
          return await this.flaresolverr.scrape(url);
        } catch (thirdError) {
          throw new Error(
            `Page providers failed: ${[firstError, secondError, thirdError]
              .map((error) => (error instanceof Error ? error.message : String(error)))
              .join('; ')}`,
          );
        }
      }
    }
  }
}
