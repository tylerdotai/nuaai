import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { sanitizedSubprocessEnvironment } from '../security/environment.js';
import { redactText } from '../security/redaction.js';
import { getVersion } from '../version.js';
import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderMessage,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderTool,
} from './types.js';

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;
const MAX_SSE_EVENT_BYTES = 8 * 1_024 * 1_024;

type FetchFunction = typeof fetch;

export interface CodexResponsesConfig {
  model: string;
  executable?: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  authPath?: string;
  modelsPath?: string;
  refreshSkewMs?: number;
  fetchFn?: FetchFunction;
  refreshAuth?: () => Promise<void>;
}

interface CodexAuth {
  accessToken: string;
  accountId?: string;
  expiresAtMs?: number;
}

function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? resolve(configured) : resolve(homedir(), '.codex');
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function authMetadata(accessToken: string): Pick<CodexAuth, 'accountId' | 'expiresAtMs'> {
  const claims = decodeJwtPayload(accessToken);
  const auth = claims?.['https://api.openai.com/auth'];
  const accountId =
    auth &&
    typeof auth === 'object' &&
    typeof (auth as Record<string, unknown>).chatgpt_account_id === 'string'
      ? ((auth as Record<string, unknown>).chatgpt_account_id as string)
      : undefined;
  const expiration = claims?.exp;
  return {
    ...(accountId ? { accountId } : {}),
    ...(typeof expiration === 'number' && Number.isFinite(expiration)
      ? { expiresAtMs: expiration * 1_000 }
      : {}),
  };
}

async function readCodexAuth(path: string): Promise<CodexAuth> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new Error('Codex authentication is unavailable. Run `codex login` and retry.');
  }
  const tokens =
    value && typeof value === 'object' ? (value as Record<string, unknown>).tokens : undefined;
  const accessToken =
    tokens && typeof tokens === 'object'
      ? (tokens as Record<string, unknown>).access_token
      : undefined;
  if (typeof accessToken !== 'string' || !accessToken.trim())
    throw new Error('Codex authentication is unavailable. Run `codex login` and retry.');
  return { accessToken: accessToken.trim(), ...authMetadata(accessToken.trim()) };
}

function isExpiring(auth: CodexAuth, skewMs: number): boolean {
  return auth.expiresAtMs !== undefined && auth.expiresAtMs <= Date.now() + skewMs;
}

function providerSafeToolName(name: string): string {
  const readable = name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  const suffix = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `${readable.slice(0, 55)}_${suffix}`;
}

function toolManifest(tools: ProviderTool[] = []): {
  wire: Array<Record<string, unknown>>;
  names: Map<string, string>;
} {
  const names = new Map<string, string>();
  const wire = tools.map((tool) => {
    const name = providerSafeToolName(tool.name);
    names.set(name, tool.name);
    return {
      type: 'function',
      name,
      description: `NUAAI tool \`${tool.name}\`. ${tool.description}`,
      strict: false,
      parameters: tool.parameters,
    };
  });
  return { wire, names };
}

function imagePart(image: NonNullable<ProviderMessage['images']>[number]): Record<string, unknown> {
  const imageUrl = image.data.startsWith('data:')
    ? image.data
    : `data:${image.mimeType || 'application/octet-stream'};base64,${image.data}`;
  return { type: 'input_image', image_url: imageUrl };
}

function textMessage(
  role: 'user' | 'assistant',
  content: string,
  images?: ProviderMessage['images'],
) {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  return {
    role,
    content: [
      ...(content ? [{ type: textType, text: content }] : []),
      ...(role === 'user' ? (images ?? []).map(imagePart) : []),
    ],
  };
}

function responseInput(
  messages: ProviderMessage[],
  tools: Map<string, string>,
): Array<Record<string, unknown>> {
  const originalToWire = new Map([...tools].map(([wire, original]) => [original, wire]));
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error('Codex tool result is missing its call id');
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    if (message.content || message.images?.length)
      input.push(textMessage(message.role, message.content, message.images));
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: originalToWire.get(call.name) ?? providerSafeToolName(call.name),
        arguments: JSON.stringify(call.arguments),
      });
    }
  }
  return input;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') throw new Error('Codex returned malformed tool arguments');
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Normalized below.
  }
  throw new Error('Codex returned malformed tool arguments');
}

function toolCallFromItem(
  item: unknown,
  names: Map<string, string>,
): Extract<ProviderStreamEvent, { type: 'tool_call' }> | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  if (record.type !== 'function_call' || typeof record.name !== 'string') return undefined;
  const id =
    typeof record.call_id === 'string'
      ? record.call_id
      : typeof record.id === 'string'
        ? record.id
        : '';
  if (!id) throw new Error('Codex returned a tool call without an id');
  return {
    type: 'tool_call',
    id,
    name: names.get(record.name) ?? record.name,
    arguments: parseToolArguments(record.arguments),
  };
}

function responseText(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const output = (response as Record<string, unknown>).output;
  if (!Array.isArray(output)) return '';
  return output
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((part) => part && typeof part === 'object')
        .map((part) => (part as Record<string, unknown>).text)
        .filter((text): text is string => typeof text === 'string');
    })
    .join('');
}

function structuredResponseError(event: Record<string, unknown>): string {
  const raw = event.error;
  if (!raw || typeof raw !== 'object') return 'Codex Responses stream failed';
  const error = raw as Record<string, unknown>;
  const code = typeof error.code === 'string' ? error.code.trim() : '';
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  const detail = [code, message].filter(Boolean).join(': ');
  if (!detail) return 'Codex Responses stream failed';
  const redacted = redactText(detail)
    .replace(/\/home\/[^/\s]+/g, '/home/[USER]')
    .replace(/\bbody:\s*[\[{].*$/is, 'body: [OMITTED]');
  return Buffer.from(redacted, 'utf8').subarray(0, 512).toString('utf8');
}

async function* sseEvents(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('Codex Responses returned an empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parseFrame = (frame: string): Record<string, unknown> | undefined => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return undefined;
    try {
      const parsed = JSON.parse(data) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      throw new Error('Codex Responses returned malformed stream data');
    }
  };
  let streamDone = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_EVENT_BYTES)
        throw new Error('Codex Responses stream event exceeded the size limit');
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + delimiter.length);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (done) {
        streamDone = true;
        break;
      }
    }
    if (buffer.trim()) {
      const parsed = parseFrame(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    try {
      if (!streamDone) await reader.cancel('NUAAI finished reading the Codex response');
    } finally {
      reader.releaseLock();
    }
  }
}

async function refreshCodexManagedAuth(
  executable: string,
  cwd: string,
  home: string,
  timeoutMs: number,
): Promise<void> {
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sanitizedSubprocessEnvironment({ CODEX_HOME: home }),
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  let settled = false;
  const refresh = new Promise<void>((resolveRefresh, rejectRefresh) => {
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      rejectRefresh(new Error(message));
    };
    const timer = setTimeout(
      () => fail('Codex-managed credential refresh timed out'),
      Math.max(1_000, timeoutMs),
    );
    timer.unref();
    child.once('error', () => fail('Codex-managed credential refresh could not start'));
    child.once('exit', () => fail('Codex-managed credential refresh exited early'));
    lines.on('line', (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) return fail('Codex-managed credential refresh initialization failed');
        child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
        child.stdin.write(
          `${JSON.stringify({ id: 2, method: 'account/read', params: { refreshToken: true } })}\n`,
        );
      } else if (message.id === 2) {
        clearTimeout(timer);
        if (message.error) return fail('Codex-managed credential refresh was rejected');
        if (!settled) {
          settled = true;
          resolveRefresh();
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'nuaai', title: 'NUAAI', version: getVersion() },
          capabilities: {},
        },
      })}\n`,
    );
  });
  try {
    await refresh;
  } finally {
    lines.close();
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

async function visibleModels(path: string): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const models =
      value && typeof value === 'object' ? (value as Record<string, unknown>).models : undefined;
    if (!Array.isArray(models)) return [];
    return models
      .filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).slug === 'string' &&
          (entry as Record<string, unknown>).visibility !== 'hide',
      )
      .map((entry) => entry.slug as string)
      .filter((slug, index, all) => Boolean(slug) && all.indexOf(slug) === index);
  } catch {
    return [];
  }
}

export class CodexResponsesProvider implements ProviderAdapter {
  readonly name = 'codex';
  readonly model: string;
  readonly ownsToolLoop = false;
  private readonly executable: string;
  private readonly workspaceRoot: string;
  private readonly timeoutMs: number;
  private readonly authPath: string;
  private readonly codexHome: string;
  private readonly modelsPath: string;
  private readonly refreshSkewMs: number;
  private readonly fetchFn: FetchFunction;
  private readonly refreshAuth: () => Promise<void>;
  private refreshPromise?: Promise<void>;

  constructor(config: CodexResponsesConfig) {
    const home = codexHome();
    this.model = config.model;
    this.executable = config.executable ?? 'codex';
    this.workspaceRoot = config.workspaceRoot ?? process.cwd();
    this.timeoutMs = config.timeoutMs ?? 180_000;
    this.authPath = config.authPath ?? resolve(home, 'auth.json');
    this.codexHome = dirname(this.authPath);
    this.modelsPath = config.modelsPath ?? resolve(home, 'models_cache.json');
    this.refreshSkewMs = config.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.fetchFn = config.fetchFn ?? fetch;
    this.refreshAuth =
      config.refreshAuth ??
      (() => refreshCodexManagedAuth(this.executable, this.workspaceRoot, this.codexHome, 30_000));
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const auth = await this.accessToken();
    const manifest = toolManifest(request.tools);
    const model = request.model.trim() || this.model;
    if (!model) throw new Error('Codex Responses requires a model');
    const instructions =
      request.systemPrompt?.trim() ||
      request.messages.find((message) => message.role === 'system')?.content.trim() ||
      'You are NUAAI. Use tools for real actions and report only verified results.';
    const body = {
      model,
      instructions,
      input: responseInput(request.messages, manifest.names),
      ...(manifest.wire.length
        ? { tools: manifest.wire, tool_choice: 'auto', parallel_tool_calls: true }
        : {}),
      store: false,
      stream: true,
      ...(request.conversationId ? { prompt_cache_key: request.conversationId.slice(0, 64) } : {}),
    };
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('Codex Responses request timed out')),
      this.timeoutMs,
    );
    timeout.unref();
    let response: Response;
    try {
      response = await this.fetchFn(CODEX_RESPONSES_URL, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': `NUAAI/${getVersion()}`,
          originator: 'nuaai',
          ...(auth.accountId ? { 'ChatGPT-Account-ID': auth.accountId } : {}),
          ...(request.conversationId
            ? {
                session_id: request.conversationId,
                'x-client-request-id': request.conversationId.slice(0, 64),
              }
            : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        if (response.body)
          try {
            await response.body.cancel('NUAAI rejected the Codex HTTP response');
          } catch (error) {
            throw new Error(
              `Codex Responses request failed (${response.status}); response cleanup failed`,
              { cause: error },
            );
          }
        const hint =
          response.status === 401 || response.status === 403
            ? '. Run `codex login` and retry.'
            : response.status === 429
              ? '. Codex usage limit reached; retry after the account resets.'
              : '';
        throw new Error(`Codex Responses request failed (${response.status})${hint}`);
      }
      let terminal = false;
      let emittedText = false;
      const emittedCalls = new Set<string>();
      for await (const event of sseEvents(response)) {
        const type = event.type;
        if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
          emittedText = true;
          yield { type: 'delta', text: event.delta };
          continue;
        }
        if (type === 'response.output_item.done') {
          const call = toolCallFromItem(event.item, manifest.names);
          if (call && !emittedCalls.has(call.id)) {
            emittedCalls.add(call.id);
            yield call;
          }
          continue;
        }
        if (type === 'response.completed') {
          const completed = event.response;
          if (completed && typeof completed === 'object') {
            const output = (completed as Record<string, unknown>).output;
            if (Array.isArray(output))
              for (const item of output) {
                const call = toolCallFromItem(item, manifest.names);
                if (call && !emittedCalls.has(call.id)) {
                  emittedCalls.add(call.id);
                  yield call;
                }
              }
          }
          if (!emittedText) {
            const text = responseText(completed);
            if (text) {
              emittedText = true;
              yield { type: 'delta', text };
            }
          }
          terminal = true;
          break;
        }
        if (type === 'response.failed' || type === 'response.incomplete')
          throw new Error(
            `Codex Responses ${type === 'response.failed' ? 'failed' : 'was incomplete'}`,
          );
        if (type === 'error') throw new Error(structuredResponseError(event));
      }
      if (!terminal) throw new Error('Codex Responses stream ended without a terminal event');
      yield { type: 'done', text: '' };
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error('Codex Responses request aborted');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
    }
  }

  async embed(): Promise<number[]> {
    throw new Error('Codex does not provide embeddings; configure Ollama for memory embeddings');
  }

  async health(): Promise<ProviderHealth> {
    try {
      await this.accessToken();
      const models = await visibleModels(this.modelsPath);
      return {
        name: this.name,
        available: true,
        detail: 'ChatGPT OAuth ready · direct Responses',
        ...(models.length ? { models } : {}),
      };
    } catch (error) {
      return {
        name: this.name,
        available: false,
        detail: error instanceof Error ? error.message : 'Codex authentication is unavailable',
      };
    }
  }

  private async accessToken(): Promise<CodexAuth> {
    let auth = await readCodexAuth(this.authPath);
    if (!isExpiring(auth, this.refreshSkewMs)) return auth;
    this.refreshPromise ??= this.refreshAuth().finally(() => {
      this.refreshPromise = undefined;
    });
    await this.refreshPromise;
    auth = await readCodexAuth(this.authPath);
    if (isExpiring(auth, this.refreshSkewMs))
      throw new Error(
        'Codex authentication refresh did not produce a usable token. Run `codex login`.',
      );
    return auth;
  }
}
