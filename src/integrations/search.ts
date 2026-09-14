import { existsSync } from 'node:fs';

import { PublicOutboundUrlPolicy } from '../security/outbound-url.js';

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
    private readonly outboundUrlPolicy = new PublicOutboundUrlPolicy(),
  ) {}

  async crawl(url: string): Promise<PageResult> {
    const target = (await this.outboundUrlPolicy.assertAllowed(url)).toString();
    const response = await this.fetchImpl(new URL('/crawl', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: [target], bypass_cache: true, word_count_threshold: 10 }),
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
    const resultUrl = (await this.outboundUrlPolicy.assertAllowed(result.url ?? target)).toString();
    return { url: resultUrl, title: result.title ?? '', text };
  }
}

export interface BrowserSession {
  newPage(options: { serviceWorkers: 'block' }): Promise<{
    route(
      pattern: string,
      handler: (route: {
        request(): { url(): string };
        fetch(options: { maxRedirects: 0 }): Promise<{ status(): number }>;
        fulfill(options: { response: { status(): number } }): Promise<void>;
        abort(): Promise<void>;
      }) => Promise<void>,
    ): Promise<void>;
    routeWebSocket(
      pattern: string,
      handler: (route: { close(options?: { code?: number; reason?: string }): void }) => void,
    ): Promise<void>;
    goto(
      url: string,
      options: { waitUntil: 'domcontentloaded'; timeout: number },
    ): Promise<unknown>;
    url(): string;
    title(): Promise<string>;
    locator(selector: string): { innerText(options: { timeout: number }): Promise<string> };
  }>;
  close(): Promise<void>;
}

interface BrowserLaunchOptions {
  headless: true;
  executablePath?: string;
  channel?: 'chrome';
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 300 ? message : `${message.slice(0, 299)}…`;
}

export async function launchBrowserWithFallback(options: {
  configuredExecutablePath?: string;
  managedExecutablePath: string;
  exists?: (path: string) => boolean;
  launch(options: BrowserLaunchOptions): Promise<BrowserSession>;
}): Promise<BrowserSession> {
  const exists = options.exists ?? existsSync;
  const failures: string[] = [];
  const configured = options.configuredExecutablePath?.trim();
  if (configured) {
    if (exists(configured)) {
      try {
        return await options.launch({ executablePath: configured, headless: true });
      } catch (error) {
        failures.push(`configured executable ${configured}: ${boundedError(error)}`);
      }
    } else failures.push(`configured executable missing at ${configured}`);
  }
  if (exists(options.managedExecutablePath)) {
    try {
      return await options.launch({
        executablePath: options.managedExecutablePath,
        headless: true,
      });
    } catch (error) {
      failures.push(`managed Chromium ${options.managedExecutablePath}: ${boundedError(error)}`);
    }
  } else failures.push(`managed Chromium missing at ${options.managedExecutablePath}`);
  try {
    return await options.launch({ channel: 'chrome', headless: true });
  } catch (error) {
    failures.push(`system Chrome: ${boundedError(error)}`);
  }
  throw new Error(
    `Browser launch failed: ${failures.join('; ')}. Run \`npx playwright install chromium\` or configure a valid Chrome executable.`,
  );
}

export class BrowserAutomationClient {
  constructor(
    private readonly options: {
      launch?: () => Promise<BrowserSession>;
      timeoutMs?: number;
      maxTextBytes?: number;
      urlPolicy?: PublicOutboundUrlPolicy;
    } = {},
  ) {}

  async crawl(url: string): Promise<PageResult> {
    return this.open(url);
  }

  async open(rawUrl: string): Promise<PageResult> {
    const policy = this.options.urlPolicy ?? new PublicOutboundUrlPolicy();
    const url = (await policy.assertAllowed(rawUrl)).toString();
    const browser = await (
      this.options.launch ??
      (async () => {
        const playwrightPackage = 'playwright';
        const { chromium } = (await import(playwrightPackage)) as typeof import('playwright');
        return launchBrowserWithFallback({
          ...(process.env.NUAAI_PLAYWRIGHT_EXECUTABLE_PATH?.trim()
            ? { configuredExecutablePath: process.env.NUAAI_PLAYWRIGHT_EXECUTABLE_PATH.trim() }
            : {}),
          managedExecutablePath: chromium.executablePath(),
          launch: (launchOptions) =>
            chromium.launch(launchOptions) as unknown as Promise<BrowserSession>,
        });
      })
    )();
    try {
      const page = await browser.newPage({ serviceWorkers: 'block' });
      let blockedNavigation: Error | undefined;
      await page.route('**/*', async (route) => {
        try {
          await policy.assertAllowed(route.request().url());
          const response = await route.fetch({ maxRedirects: 0 });
          if (response.status() === 101 || (response.status() >= 300 && response.status() < 400))
            throw new Error(
              'Browser redirects are blocked; protocol upgrades are blocked by outbound policy',
            );
          await route.fulfill({ response });
        } catch (error) {
          blockedNavigation = error instanceof Error ? error : new Error(String(error));
          await route.abort();
        }
      });
      await page.routeWebSocket('**/*', (route) => {
        route.close({ code: 1008, reason: 'Blocked by NUAAI outbound policy' });
      });
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: this.options.timeoutMs ?? 30_000,
        });
      } catch (error) {
        if (blockedNavigation) throw blockedNavigation;
        throw error;
      }
      if (blockedNavigation) throw blockedNavigation;
      const finalUrl = (await policy.assertAllowed(page.url())).toString();
      const text = await page
        .locator('body')
        .innerText({ timeout: this.options.timeoutMs ?? 30_000 });
      return {
        url: finalUrl,
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
    private readonly outboundUrlPolicy = new PublicOutboundUrlPolicy(),
  ) {}

  async crawl(url: string): Promise<PageResult> {
    return this.scrape(url);
  }

  async scrape(url: string): Promise<PageResult> {
    const target = (await this.outboundUrlPolicy.assertAllowed(url)).toString();
    const response = await this.fetchImpl(new URL('/v1', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url: target, maxTimeout: 60_000 }),
      signal: AbortSignal.timeout(75_000),
    });
    const value = (await readJson(response)) as {
      solution?: { url?: string; response?: string; title?: string };
    };
    const solution = value.solution;
    if (!solution?.response) throw new Error('FlareSolverr returned no page response');
    const resultUrl = (
      await this.outboundUrlPolicy.assertAllowed(solution.url ?? target)
    ).toString();
    return { url: resultUrl, title: solution.title ?? '', text: solution.response };
  }
}

interface SearchClient {
  search(query: string, limit?: number): Promise<SearchResult[]>;
}
interface BrowserClient {
  open(url: string): Promise<PageResult>;
}

export class SearchStack {
  private readonly searxng: SearchClient;
  private readonly duckduckgo: SearchClient;
  private readonly browser?: BrowserClient;
  private readonly outboundUrlPolicy: PublicOutboundUrlPolicy;

  constructor(
    options: {
      searxng?: SearchClient;
      duckduckgo?: SearchClient;
      browser?: BrowserClient | null;
      urlPolicy?: PublicOutboundUrlPolicy;
    } = {},
  ) {
    this.outboundUrlPolicy = options.urlPolicy ?? new PublicOutboundUrlPolicy();
    this.searxng = options.searxng ?? new SearxngSearchClient('http://127.0.0.1:40102');
    this.duckduckgo = options.duckduckgo ?? new DuckDuckGoSearchClient();
    this.browser =
      options.browser === null
        ? undefined
        : (options.browser ?? new BrowserAutomationClient({ urlPolicy: this.outboundUrlPolicy }));
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
    const target = (await this.outboundUrlPolicy.assertAllowed(url)).toString();
    return this.browser.open(target);
  }

  async fetch(url: string): Promise<PageResult> {
    return this.open(url);
  }
}
