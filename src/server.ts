import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';
import { type WebSocket, WebSocketServer } from 'ws';

import { z } from 'zod';
import { RunArtifactRegistry } from './artifacts/registry.js';
import { harnessConfig, learningModeSchema } from './config/index.js';
import type { KnowledgeLearner } from './memory/learning.js';

import { ApprovalStateError, approvalStatuses } from './core/approvals.js';
import { executionRequestSchema } from './core/execution-policy.js';
import type { AgentRuntime } from './core/runtime.js';
import type { Scheduler } from './core/scheduler.js';
import { effectiveRequestOrigin } from './gateway/origin.js';
import { createToken, inspectToken, validateToken } from './gateway/token.js';
import { decodeInputAttachments } from './integrations/input-attachments.js';
import type { McpManager } from './integrations/mcp.js';
import type { DatabaseStore, EventPage, RunArtifactRow, RunRow } from './memory/db.js';
import type { PluginRegistry } from './plugins/registry.js';
import type { ProviderRegistry } from './providers/registry.js';
import {
  type PermissionContext,
  type PermissionProfile,
  permissionContextForProfile,
} from './security/permissions.js';
import { redactText } from './security/redaction.js';
import type { SecretsManager } from './security/secrets.js';
import { SkillLearner } from './skills/learner.js';
import type { SkillRegistry } from './skills/registry.js';
import { getVersion } from './version.js';
import { VoiceBroker, VoiceError } from './voice/broker.js';
import { unsupportedCodexVoiceProvider } from './voice/codex-transport.js';
import { installVoiceRoutes } from './voice/http.js';
import { attachmentMaxCount } from './web/attachments.js';
import { buildThreadPresentation } from './web/presentation.js';

const maxRequestBodyBytes = 1024 * 1024;
const maxWebSocketMessageBytes = 64 * 1024;

interface LogOptions {
  level: 'info' | 'warn' | 'error';
  method?: string;
  path?: string;
  status?: number;
  error?: unknown;
  duration?: number;
}

async function logToFile(root: string, options: LogOptions): Promise<void> {
  const timestamp = new Date().toISOString();
  const level = options.level.toUpperCase().padEnd(5);
  const parts = [`[${timestamp}]`, level];
  if (options.method) parts.push(`${options.method} ${options.path}`);
  if (options.status) parts.push(`${options.status}`);
  if (options.duration) parts.push(`${options.duration}ms`);
  if (options.error) {
    const message = options.error instanceof Error ? options.error.message : String(options.error);
    parts.push(message);
  }
  const line = `${parts.join(' | ')}\n`;
  try {
    await appendFile(resolve(root, '.nuaai/logs/server.log'), redactText(line), { mode: 0o600 });
  } catch (error) {
    console.warn(
      redactText(
        `NUAAI log write failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

function log(root: string, level: 'info' | 'warn' | 'error', ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  if (level === 'error') {
    console.error(prefix, ...args);
    const error = args.find((a) => a instanceof Error) as Error | undefined;
    void logToFile(root, { level, error: error?.message ?? String(args[0]) });
  } else if (level === 'warn') {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}
const maxReplayPageSize = 1_000;
const runSnapshotEventLimit = 250;
const browserSessionTtlSeconds = 2_592_000;

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(0, Math.trunc(parsed)));
}

function globalEventPage(store: DatabaseStore, after: number, requestedLimit: number): EventPage {
  const limit = Math.max(1, requestedLimit);
  const rows = store.listEvents(after, limit + 1);
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit);
  return {
    events,
    nextCursor: events.at(-1)?.id ?? after,
    hasMore,
  };
}

function publicRun(run: RunRow): Omit<RunRow, 'input' | 'correlationId'> {
  const { input: _input, correlationId: _correlationId, ...safe } = run;
  return safe;
}

function publicRunArtifact(artifact: RunArtifactRow): Omit<RunArtifactRow, 'storagePath'> & {
  downloadUrl?: string;
} {
  const { storagePath, ...safe } = artifact;
  return {
    ...safe,
    ...(storagePath
      ? {
          downloadUrl: `api/runs/${encodeURIComponent(artifact.runId)}/artifacts/${encodeURIComponent(artifact.id)}/download`,
        }
      : {}),
  };
}

function contentDisposition(title: string): string {
  const fallback = title.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 180) || 'artifact';
  const encoded = encodeURIComponent(title).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function requestedByteRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return 'invalid';
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

function artifactDownloadHeaders(artifact: RunArtifactRow): Record<string, string> {
  return {
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-disposition': contentDisposition(artifact.title),
    'content-type': artifact.mimeType,
    'x-content-type-options': 'nosniff',
  };
}

function publicSession<T extends { context: string }>(value: T): Omit<T, 'context'> {
  const { context: _context, ...session } = value;
  return session;
}

export interface GatewayServices {
  root: string;
  port: number;
  host: string;
  authSecret: string;
  browserCookiePath?: string;
  webRoot?: string;
  now?: () => number;
  runPermissionProfile?: PermissionProfile;
  runPermissions?: PermissionContext;
  runtime: AgentRuntime;
  store: DatabaseStore;
  artifacts?: RunArtifactRegistry;
  providers: ProviderRegistry;
  scheduler: Scheduler;
  skills: SkillRegistry;
  plugins: PluginRegistry;
  secrets: SecretsManager;
  mcp?: McpManager;
  knowledge?: KnowledgeLearner;
  voice?: VoiceBroker;
}

function tokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  try {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;
  } catch {
    // ignore invalid url
  }
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('nuaai_token='));
  return cookie?.slice('nuaai_token='.length) ?? null;
}

function normalizeCookiePath(value: string | undefined): string {
  if (!value || value === '/') return '/';
  if (!value.startsWith('/') || /[;\s]/u.test(value))
    throw new Error(
      'Browser cookie path must be an absolute path without whitespace or semicolons',
    );
  return value.replace(/\/+$/u, '') || '/';
}

function authenticationFailure(token: string | null, secret: string, now: number) {
  if (token && inspectToken(token, secret, now).status === 'expired')
    return {
      error: 'Session expired — pair this device again.',
      code: 'AUTH_EXPIRED' as const,
    };
  return { error: 'Pair this device to continue.', code: 'AUTH_REQUIRED' as const };
}

function isRequestCredential(payload: ReturnType<typeof validateToken>): boolean {
  return Boolean(payload && payload.purpose !== 'browser-pairing');
}

function contentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json') || path.endsWith('.webmanifest'))
    return path.endsWith('.webmanifest')
      ? 'application/manifest+json; charset=utf-8'
      : 'application/json; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

export function createApp(services: GatewayServices): Hono {
  const app = new Hono();
  const configuredCookiePath = normalizeCookiePath(services.browserCookiePath);
  const webRoot = services.webRoot ?? fileURLToPath(new URL('../dist/web', import.meta.url));
  const now = services.now ?? Date.now;
  const runPermissionProfile = services.runPermissionProfile ?? 'read-only';
  const runPermissions =
    services.runPermissions ?? permissionContextForProfile(runPermissionProfile);
  const artifacts = services.artifacts ?? new RunArtifactRegistry(services.root, services.store);
  const protectedRoute = async (
    context: Parameters<NonNullable<Parameters<Hono['use']>[1]>>[0],
    next: () => Promise<void>,
  ) => {
    const token = tokenFromRequest(context.req.raw);
    const checkedAt = now();
    if (!token || !isRequestCredential(validateToken(token, services.authSecret, checkedAt)))
      return context.json(authenticationFailure(token, services.authSecret, checkedAt), 401);
    await next();
  };

  app.get('/health', (context) =>
    context.json({ ok: true, name: harnessConfig.name, version: getVersion(), daemon: true }),
  );
  app.get('/version', (context) =>
    context.json({ name: harnessConfig.name, version: getVersion() }),
  );
  app.post('/auth/pair', async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as { token?: string };
    const issuedAt = now();
    const pairing = body.token ? validateToken(body.token, services.authSecret, issuedAt) : null;
    if (!pairing || pairing.purpose !== 'browser-pairing')
      return context.json(
        { error: 'Invalid or expired pairing token', code: 'PAIRING_INVALID' },
        401,
      );
    const sessionToken = createToken(
      {
        sub: 'browser-session',
        purpose: 'browser-session',
        exp: Math.floor(issuedAt / 1_000) + browserSessionTtlSeconds,
      },
      services.authSecret,
      issuedAt,
    );
    const forwardedProtocol = context.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
    const forwarded = Boolean(forwardedProtocol || context.req.header('x-forwarded-host'));
    const cookiePath = normalizeCookiePath(
      context.req.header('x-nuaai-internal-mount-path') ?? (forwarded ? configuredCookiePath : '/'),
    );
    const secure = forwardedProtocol === 'https' || new URL(context.req.url).protocol === 'https:';
    context.header(
      'set-cookie',
      `nuaai_token=${sessionToken}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=${browserSessionTtlSeconds}${secure ? '; Secure' : ''}`,
    );
    context.header('cache-control', 'no-store');
    return context.json({ ok: true });
  });
  app.use('/api/*', protectedRoute);
  const voice =
    services.voice ??
    new VoiceBroker({
      provider: unsupportedCodexVoiceProvider,
      authorize: () => {
        throw new VoiceError('VOICE_DISABLED', 503, 'preflight');
      },
      admit: () => {
        throw new VoiceError('VOICE_DISABLED', 503, 'preflight');
      },
    });
  installVoiceRoutes(app, voice, (request) => {
    const token = tokenFromRequest(request);
    const auth = token ? validateToken(token, services.authSecret, now()) : null;
    if (!token || !auth || !isRequestCredential(auth)) throw new VoiceError('VOICE_FORBIDDEN', 403);
    return { owner: createHash('sha256').update(token).digest('hex'), expiresAt: auth.exp * 1_000 };
  });
  app.get('/api/status', async (context) =>
    context.json({
      ...services.runtime.status(),
      providers: await services.runtime.providerHealth(),
      webPermissionProfile: runPermissionProfile,
    }),
  );
  app.get('/api/sessions/:id/permissions', (context) => {
    if (!services.store.getSession(context.req.param('id')))
      return context.json({ error: 'Session not found' }, 404);
    return context.json(services.runtime.sessionApprovalPolicy(context.req.param('id')));
  });
  app.post('/api/sessions/:id/permissions', async (context) => {
    if (!services.store.getSession(context.req.param('id')))
      return context.json({ error: 'Session not found' }, 404);
    const parsed = z
      .object({
        mode: z.enum(['manual', 'smart', 'unguarded']),
        revokeGrants: z.boolean().default(false),
        confirmUnguarded: z.boolean().default(false),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success || (parsed.data.mode === 'unguarded' && !parsed.data.confirmUnguarded))
      return context.json(
        { error: 'Valid mode and explicit Unguarded confirmation required' },
        400,
      );
    return context.json(
      services.runtime.setSessionApprovalPolicy(
        context.req.param('id'),
        parsed.data.mode,
        parsed.data.revokeGrants,
      ),
    );
  });
  app.get('/api/goals', (context) =>
    context.json({ goals: services.store.listGoals(context.req.query('threadId')) }),
  );
  app.get('/api/approvals', (context) => {
    const requestedStatus = context.req.query('status');
    if (requestedStatus && !approvalStatuses.includes(requestedStatus as never))
      return context.json({ error: 'Invalid approval status' }, 400);
    return context.json({
      approvals: services.runtime.listApprovals(requestedStatus as never),
    });
  });
  app.get('/api/approvals/:id', (context) => {
    const approval = services.runtime.getApproval(context.req.param('id'));
    return approval ? context.json(approval) : context.json({ error: 'Approval not found' }, 404);
  });
  app.post('/api/approvals/:id/approve', async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      payloadHash?: string;
      scope?: string;
    };
    if (!body.payloadHash?.match(/^[a-f0-9]{64}$/u))
      return context.json({ error: 'payloadHash is required' }, 400);
    if (body.scope !== undefined && !['once', 'session'].includes(body.scope))
      return context.json({ error: 'Invalid approval scope' }, 400);
    try {
      return context.json(
        services.runtime.approveApproval(
          context.req.param('id'),
          body.payloadHash,
          (body.scope ?? 'once') as 'once' | 'session',
        ),
      );
    } catch (error) {
      const status =
        error instanceof ApprovalStateError && error.code === 'approval_not_found' ? 404 : 409;
      return context.json(
        { error: error instanceof Error ? error.message : String(error) },
        status,
      );
    }
  });
  app.post('/api/approvals/:id/deny', async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      payloadHash?: string;
      scope?: string;
    };
    if (!body.payloadHash?.match(/^[a-f0-9]{64}$/u))
      return context.json({ error: 'payloadHash is required' }, 400);
    try {
      return context.json(services.runtime.denyApproval(context.req.param('id'), body.payloadHash));
    } catch (error) {
      const status =
        error instanceof ApprovalStateError && error.code === 'approval_not_found' ? 404 : 409;
      return context.json(
        { error: error instanceof Error ? error.message : String(error) },
        status,
      );
    }
  });
  app.get('/api/tools', (context) => context.json({ tools: services.runtime.listTools() }));
  app.get('/api/tools/:name', (context) => {
    const tool = services.runtime.getTool(context.req.param('name'));
    return tool ? context.json({ tool }) : context.json({ error: 'Tool not found' }, 404);
  });
  app.get('/api/tools/:name/schema', (context) => {
    const schema = services.runtime.getToolSchema(context.req.param('name'));
    return schema ? context.json({ schema }) : context.json({ error: 'Tool not found' }, 404);
  });

  const HEARTBEAT_INTERVAL_MS = 15_000;
  const MAX_EVENTS_BUFFER = 100;
  const eventBuffer: Array<{ id: number; data: string; sessionId?: string; type: string }> = [];
  let eventIdCounter = 0;

  function sseFormat(eventType: string, data: unknown, id?: number): string {
    const lines = [`event: ${eventType}`, `data: ${JSON.stringify(data)}`];
    if (id !== undefined) lines.unshift(`id: ${id}`);
    return `${lines.join('\n')}\n\n`;
  }

  function mapEventType(type: string): string {
    if (type === 'model.delta') return 'token';
    if (type === 'tool.started') return 'tool_start';
    if (type === 'tool.completed' || type === 'tool.failed') return 'tool_end';
    if (type === 'model.completed') return 'done';
    if (type === 'run.started' || type === 'run.completed') return 'status';
    if (type === 'run.failed') return 'error';
    return type;
  }

  app.get('/api/agent/stream', async (context) => {
    const token = tokenFromRequest(context.req.raw);
    const checkedAt = (services.now ?? Date.now)();
    if (!token || !isRequestCredential(validateToken(token, services.authSecret, checkedAt))) {
      return context.json({ error: 'Unauthorized' }, 401);
    }

    const sessionId = context.req.query('session_id') || null;
    const dropTypes = new Set(
      (context.req.query('drop') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
    const lastEventId = context.req.raw.headers.get('Last-Event-ID');
    const startEventId = lastEventId ? Math.max(0, Number.parseInt(lastEventId, 10) + 1) : 0;

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    let closed = false;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      unsubscribe?.();
    };

    const stream = new ReadableStream({
      start(controller) {
        heartbeatTimer = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
          } catch {
            cleanup();
          }
        }, HEARTBEAT_INTERVAL_MS);

        context.req.raw.signal.addEventListener('abort', () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
          cleanup();
        });

        if (startEventId > 0 && eventBuffer.length > 0) {
          for (const { id, data, sessionId: owner, type } of eventBuffer) {
            if (sessionId && owner !== sessionId) continue;
            if (dropTypes.has(type) || dropTypes.has(mapEventType(type))) continue;
            if (id >= startEventId) {
              try {
                controller.enqueue(new TextEncoder().encode(data));
              } catch {
                break;
              }
            }
          }
        }

        unsubscribe = services.runtime.subscribe((event) => {
          if (closed) return;
          if (sessionId && event.sessionId && event.sessionId !== sessionId) return;
          if (event.sessionId === undefined && sessionId !== null) return;
          if (dropTypes.size > 0) {
            const mapped = mapEventType(event.type);
            if (dropTypes.has(event.type) || (mapped && dropTypes.has(mapped))) return;
          }

          const id = event.id ?? ++eventIdCounter;
          eventIdCounter = Math.max(eventIdCounter, id);
          const eventType: string = mapEventType(event.type);
          let eventData: Record<string, unknown> = { ...event.payload };

          if (event.type === 'model.delta') {
            eventData = { content: event.payload.text ?? '' };
          } else if (event.type === 'tool.started') {
            eventData = {
              name: event.payload.name,
              args: event.payload.arguments ?? {},
            };
          } else if (event.type === 'tool.completed') {
            eventData = {
              name: event.payload.name,
              result: event.payload.result,
            };
          } else if (event.type === 'tool.failed') {
            eventData = {
              name: event.payload.name,
              error: event.payload.error ?? 'Tool failed',
            };
          } else if (event.type === 'model.completed') {
            eventData = { full_response: event.payload.text ?? '' };
          } else if (event.type === 'run.started') {
            eventData = { label: 'Thinking...' };
          } else if (event.type === 'run.completed') {
            eventData = { label: 'Completed' };
          } else if (event.type === 'run.failed') {
            eventData = { message: String(event.payload.error ?? 'Run failed') };
          }

          const sseData = {
            ...eventData,
            id,
            type: eventType,
            runId: event.runId,
            taskId: event.taskId,
            sessionId: event.sessionId,
            threadId: event.threadId,
            createdAt: event.createdAt,
            event: {
              id: event.id,
              type: event.type,
              runId: event.runId,
              taskId: event.taskId,
              sessionId: event.sessionId,
              threadId: event.threadId,
              createdAt: event.createdAt,
              payload: event.payload,
              eventId: event.eventId,
              source: event.source,
              correlationId: event.correlationId,
              schemaVersion: event.schemaVersion,
            },
          };
          const sseLine = sseFormat(eventType, sseData, id);
          if (eventBuffer.at(-1)?.id !== id)
            eventBuffer.push({ id, data: sseLine, sessionId: event.sessionId, type: event.type });
          if (eventBuffer.length > MAX_EVENTS_BUFFER) eventBuffer.shift();

          try {
            controller.enqueue(new TextEncoder().encode(sseLine));
          } catch {
            // Client disconnected
          }
        });
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      },
    });
  });

  app.get('/api/sessions', (context) =>
    context.json({
      sessions: services.runtime
        .listSessions(context.req.query('includeOrphans') === 'true')
        .map(publicSession),
    }),
  );
  app.post('/api/sessions', async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      title?: string;
      sourceKey?: string;
      workspaceRoot?: string;
      parentSessionId?: string;
    };
    try {
      const created = services.runtime.createSession(body.title, body.sourceKey, undefined, {
        workspaceRoot: body.workspaceRoot,
        parentSessionId: body.parentSessionId,
      });
      return context.json({ ...created, session: publicSession(created.session) });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post('/api/sessions/resolve', async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      title?: string;
      sourceKey?: string;
      workspaceRoot?: string;
    };
    if (!body.sourceKey?.trim()) return context.json({ error: 'sourceKey is required' }, 400);
    try {
      const created = services.runtime.getOrCreateSession(body.sourceKey, body.title, {
        workspaceRoot: body.workspaceRoot,
      });
      return context.json({ ...created, session: publicSession(created.session) });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post('/api/sessions/:id/threads', async (context) => {
    try {
      const body = (await context.req.json().catch(() => ({}))) as {
        title?: string;
        sourceKey?: string;
      };
      return context.json({
        thread: body.sourceKey
          ? services.runtime.getOrCreateThread(context.req.param('id'), body.sourceKey, body.title)
          : services.runtime.createThread(context.req.param('id'), body.title),
      });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.get('/api/sessions/:id', (context) => {
    const session = services.runtime.getSession(context.req.param('id'));
    return session
      ? context.json({
          session: publicSession(session),
          threads: services.runtime.listThreads(session.id),
          identity: services.runtime.sessionIdentityStatus(session.id),
        })
      : context.json({ error: 'Session not found' }, 404);
  });
  app.post('/api/sessions/:id/switch', (context) => {
    const session = services.runtime.getSession(context.req.param('id'));
    return session
      ? context.json({
          session: publicSession(session),
          threads: services.runtime.listThreads(session.id),
          active: true,
        })
      : context.json({ error: 'Session not found' }, 404);
  });
  app.get('/api/sessions/:id/identity', (context) => {
    if (!services.runtime.getSession(context.req.param('id')))
      return context.json({ error: 'Session not found' }, 404);
    try {
      return context.json(services.runtime.sessionIdentityStatus(context.req.param('id')));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post('/api/sessions/:id/identity/refresh', (context) => {
    if (!services.runtime.getSession(context.req.param('id')))
      return context.json({ error: 'Session not found' }, 404);
    try {
      return context.json(services.runtime.refreshSessionIdentity(context.req.param('id')));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.put('/api/sessions/:id', async (context) => {
    const { title } = await context.req.json();
    if (typeof title !== 'string' || !title.trim()) {
      return context.json({ error: 'title is required' }, 400);
    }
    const updated = services.runtime.renameSession(context.req.param('id'), title.trim());
    return updated ? context.json({ ok: true }) : context.json({ error: 'Session not found' }, 404);
  });
  app.delete('/api/sessions/:id', (context) => {
    const deleted = services.runtime.deleteSession(context.req.param('id'));
    return deleted ? context.json({ ok: true }) : context.json({ error: 'Session not found' }, 404);
  });
  app.put('/api/threads/:id', async (context) => {
    const { title } = await context.req.json();
    if (typeof title !== 'string' || !title.trim()) {
      return context.json({ error: 'title is required' }, 400);
    }
    const updated = services.runtime.renameThread(context.req.param('id'), title.trim());
    return updated ? context.json({ ok: true }) : context.json({ error: 'Thread not found' }, 404);
  });
  app.delete('/api/threads/:id', (context) => {
    const deleted = services.runtime.deleteThread(context.req.param('id'));
    return deleted ? context.json({ ok: true }) : context.json({ error: 'Thread not found' }, 404);
  });
  app.get('/api/threads/:id/messages', (context) =>
    context.json({ messages: services.runtime.listMessages(context.req.param('id')) }),
  );
  app.get('/api/threads/:id/presentation', (context) => {
    const threadId = context.req.param('id');
    if (!services.store.getThread(threadId))
      return context.json({ error: 'Thread not found' }, 404);
    const beforeValue = context.req.query('before');
    const before =
      beforeValue === undefined
        ? undefined
        : boundedInteger(beforeValue, 0, Number.MAX_SAFE_INTEGER);
    const limit = Math.max(1, boundedInteger(context.req.query('limit'), 100, 500));
    return context.json(
      buildThreadPresentation(services.store, threadId, {
        ...(before ? { before } : {}),
        limit,
      }),
    );
  });
  app.get('/api/threads/:id/run-state', (context) => {
    const threadId = context.req.param('id');
    const thread = services.store.getThread(threadId);
    if (!thread) return context.json({ error: 'Thread not found' }, 404);
    const activeRuns = services.store.listActiveRunsForThread(threadId);
    const run = activeRuns[0] ?? services.store.getLatestRun(threadId);
    const events = run
      ? services.store.listProjectionEventsForRun(run.id, runSnapshotEventLimit)
      : [];
    return context.json({
      version: 1,
      threadId,
      run: run ? publicRun(run) : null,
      activeRunId: activeRuns[0]?.id ?? null,
      queuedRunIds: activeRuns
        .filter((activeRun) => activeRun.status === 'queued')
        .map((run) => run.id),
      queuedRuns: activeRuns
        .filter((activeRun) => activeRun.status === 'queued')
        .map((queuedRun) => ({
          id: queuedRun.id,
          input: queuedRun.input,
          createdAt: queuedRun.createdAt,
        })),
      events,
      lastEventId: services.store.eventHighWaterForSession(thread.sessionId),
    });
  });
  app.post('/api/runs', async (context) => {
    const body = (await context.req.json()) as {
      attachments?: unknown;
      execution?: unknown;
      idempotencyKey?: unknown;
      threadId?: string;
      input?: string;
      provider?: string;
      model?: string;
    };
    if (!body.threadId || !body.input)
      return context.json({ error: 'threadId and input are required' }, 400);
    try {
      if (
        body.idempotencyKey !== undefined &&
        (typeof body.idempotencyKey !== 'string' ||
          !body.idempotencyKey.trim() ||
          body.idempotencyKey.length > 256)
      )
        return context.json(
          { error: 'idempotencyKey must be a nonempty string of at most 256 characters' },
          400,
        );
      const material =
        Array.isArray(body.attachments) && body.attachments.length <= attachmentMaxCount
          ? await Promise.all(
              body.attachments.map(async (entry) => {
                if (entry && typeof entry.data === 'string') return entry;
                const meta =
                  entry && typeof entry.id === 'string' ? uploadRegistry.get(entry.id) : undefined;
                if (!meta || entry.url !== `api/uploads/${entry.id}` || entry.name !== meta.name)
                  throw new Error('Uploaded attachment is unavailable; attach the file again.');
                return {
                  name: meta.name,
                  data: (
                    await readFile(resolve(services.root, '.nuaai/uploads', entry.id))
                  ).toString('base64'),
                };
              }),
            )
          : body.attachments;
      const attachments = decodeInputAttachments(material);
      return context.json(
        services.runtime.startRun({
          threadId: body.threadId,
          input: [body.input, attachments.text].filter(Boolean).join('\n\n'),
          verificationInput: body.input,
          execution: executionRequestSchema.parse(body.execution ?? { mode: 'standard' }),
          images: attachments.images,
          provider: body.provider,
          model: body.model,
          permissions: runPermissions,
          permissionSource: 'web',
          idempotencyKey: body.idempotencyKey,
        }),
      );
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  const uploadRegistry = new Map<string, { name: string; type: string }>();
  app.post('/api/uploads', async (context) => {
    try {
      const formData = await context.req.raw.formData();
      const files: Array<{ id: string; name: string; type: string; size: number; url: string }> =
        [];
      const uploadDir = resolve(services.root, '.nuaai', 'uploads');
      await mkdir(uploadDir, { recursive: true });
      const entries: [string, File][] = [];
      formData.forEach((value, key) => {
        if (value instanceof File) entries.push([key, value]);
      });
      const material = await Promise.all(
        entries.map(async ([_name, value]) => ({
          value,
          buffer: Buffer.from(await value.arrayBuffer()),
        })),
      );
      decodeInputAttachments(
        material.map(({ value, buffer }) => ({
          name: value.name,
          data: buffer.toString('base64'),
        })),
      );
      for (const { value, buffer } of material) {
        const id = randomUUID();
        const filepath = join(uploadDir, id);
        await writeFile(filepath, buffer);
        uploadRegistry.set(id, {
          name: value.name,
          type: value.type || 'application/octet-stream',
        });
        files.push({
          id,
          name: value.name,
          type: value.type || 'application/octet-stream',
          size: buffer.length,
          url: `api/uploads/${id}`,
        });
      }
      return context.json({ files });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get('/api/uploads/:id', async (context) => {
    const id = context.req.param('id');
    const uploadDir = resolve(services.root, '.nuaai', 'uploads');
    const file = join(uploadDir, id);
    const meta = uploadRegistry.get(id);
    if (!meta) return context.json({ error: 'File not found' }, 404);
    try {
      const fileContent = await readFile(file);
      return new Response(fileContent, {
        headers: {
          'Content-Type': meta.type || 'application/octet-stream',
          'Content-Disposition': contentDisposition(meta.name),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        },
      });
    } catch {
      return context.json({ error: 'File not found' }, 404);
    }
  });
  app.post('/api/runs/:id/resume', (context) => {
    try {
      return context.json(services.runtime.resumeRun(context.req.param('id')));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get('/api/runs/:runId/artifacts', (context) => {
    const runId = context.req.param('runId');
    if (!services.store.getRun(runId)) return context.json({ error: 'Run not found' }, 404);
    context.header('cache-control', 'private, no-store');
    return context.json({
      artifacts: services.store.listRunArtifacts(runId).map(publicRunArtifact),
    });
  });
  app.get('/api/runs/:runId/artifacts/:artifactId', (context) => {
    const runId = context.req.param('runId');
    const artifact = services.store.getRunArtifact(context.req.param('artifactId'));
    if (!services.store.getRun(runId) || !artifact || artifact.runId !== runId)
      return context.json({ error: 'Artifact not found' }, 404);
    context.header('cache-control', 'private, no-store');
    return context.json(publicRunArtifact(artifact));
  });
  app.get('/api/runs/:runId/artifacts/:artifactId/download', async (context) => {
    const runId = context.req.param('runId');
    const artifact = services.store.getRunArtifact(context.req.param('artifactId'));
    if (
      !services.store.getRun(runId) ||
      !artifact ||
      artifact.runId !== runId ||
      !artifact.storagePath
    )
      return context.json({ error: 'Artifact not found' }, 404);
    let bytes: Buffer;
    try {
      bytes = await artifacts.readStored(artifact);
    } catch {
      return context.json({ error: 'Artifact not found' }, 404);
    }
    const headers = artifactDownloadHeaders(artifact);
    const range = requestedByteRange(context.req.header('range'), bytes.byteLength);
    if (range === 'invalid')
      return new Response(JSON.stringify({ error: 'Requested range is not satisfiable' }), {
        status: 416,
        headers: {
          ...headers,
          'content-range': `bytes */${bytes.byteLength}`,
          'content-type': 'application/json; charset=utf-8',
        },
      });
    if (range) {
      const partial = bytes.subarray(range.start, range.end + 1);
      return new Response(partial, {
        status: 206,
        headers: {
          ...headers,
          'content-length': String(partial.byteLength),
          'content-range': `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
        },
      });
    }
    return new Response(bytes, {
      status: 200,
      headers: { ...headers, 'content-length': String(bytes.byteLength) },
    });
  });
  app.get('/api/runs/:id', (context) => {
    const run = services.store.getRun(context.req.param('id'));
    return run ? context.json(run) : context.json({ error: 'Run not found' }, 404);
  });
  app.post('/api/runs/:id/cancel', (context) => {
    try {
      services.runtime.cancelRun(context.req.param('id'));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.post('/api/threads/:threadId/runs/:runId/cancel', (context) => {
    const threadId = context.req.param('threadId');
    if (!services.store.getThread(threadId))
      return context.json({ error: 'Thread not found' }, 404);
    const run = services.store.getRun(context.req.param('runId'));
    if (!run) return context.json({ error: 'Run not found' }, 404);
    if (run.threadId !== threadId)
      return context.json({ error: 'Run does not belong to this thread' }, 409);
    if (!['queued', 'running', 'paused'].includes(run.status))
      return context.json({ error: 'Run is not active' }, 409);
    try {
      services.runtime.cancelRun(run.id);
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.get('/api/events', (context) => {
    const after = boundedInteger(context.req.query('after'), 0, Number.MAX_SAFE_INTEGER);
    const limit = Math.max(1, boundedInteger(context.req.query('limit'), 250, maxReplayPageSize));
    const sessionId = context.req.query('sessionId');
    const threadId = context.req.query('threadId');
    const page = threadId
      ? services.store.listEventsForThread(threadId, after, limit)
      : sessionId
        ? services.store.listEventsForSession(sessionId, after, limit)
        : globalEventPage(services.store, after, limit);
    return context.json(page);
  });
  app.get('/api/providers', async (context) =>
    context.json({
      ...(await services.providers.catalog()),
      webPermissionProfile: runPermissionProfile,
    }),
  );
  app.post('/api/providers/switch', async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      provider?: string;
      model?: string;
    };
    if (!body.provider || !body.model)
      return context.json({ error: 'provider and model are required' }, 400);
    try {
      return context.json({ active: await services.providers.switch(body.provider, body.model) });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get('/api/mcp', (context) =>
    context.json(services.mcp?.status() ?? { servers: [], failures: {} }),
  );
  app.get('/api/memory/learning', (context) =>
    context.json(services.knowledge?.status() ?? { available: false, enabled: false, mode: 'off' }),
  );
  app.post('/api/memory/learning', async (context) => {
    if (!services.knowledge)
      return context.json({ error: 'Learning controls are unavailable' }, 503);
    const parsed = z
      .object({ mode: learningModeSchema })
      .strict()
      .safeParse(await context.req.json());
    if (!parsed.success)
      return context.json(
        { error: 'A valid exact learning mode is required: automatic, manual, or off' },
        400,
      );
    try {
      return context.json(await services.knowledge.setMode(parsed.data.mode));
    } catch (error) {
      const correlationId = randomUUID();
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : error instanceof SyntaxError
            ? 'CONFIG_PARSE_FAILED'
            : 'CONFIG_UPDATE_FAILED';
      services.runtime.publishEvent(
        'knowledge.mode.failed',
        {
          requestedMode: parsed.data.mode,
          failureCode: code,
          failureClass: error instanceof Error ? error.name : 'unknown',
        },
        { correlationId },
      );
      return context.json(
        {
          error:
            'Learning mode update could not be persisted and verified; reload the actual setting before retrying',
          failureCode: code,
          correlationId,
        },
        500,
      );
    }
  });
  app.post('/api/memory/:id/revert', (context) => {
    if (!services.knowledge)
      return context.json({ error: 'Learning history controls are unavailable' }, 503);
    try {
      return context.json(services.knowledge.revert(context.req.param('id')));
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Learning history could not be safely reverted',
        },
        409,
      );
    }
  });
  app.get('/api/memory', (context) =>
    context.json({
      memories: services.store
        .searchMemoryRows()
        .map(({ embedding, ...memory }) => ({ ...memory, hasEmbedding: Boolean(embedding) })),
    }),
  );
  app.post('/api/memory', async (context) => {
    try {
      const { content, metadata } = await context.req.json();
      if (metadata && typeof metadata === 'object' && Object.hasOwn(metadata, 'knowledge'))
        return context.json(
          { error: 'Knowledge provenance is reserved for daemon-owned memory operations' },
          400,
        );
      if (typeof content !== 'string' || !content.trim()) {
        return context.json({ error: 'content is required' }, 400);
      }
      let embedding: number[] | null = null;
      try {
        embedding = services.providers
          ? await services.providers.get('ollama').embed(content)
          : null;
      } catch {
        // embedding unavailable - store lexically only
      }
      const id = randomUUID();
      services.store.storeMemory(id, content.trim(), embedding, metadata ?? {});
      return context.json({ id, hasEmbedding: Boolean(embedding) }, 201);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.delete('/api/memory/:id', (context) => {
    try {
      const deleted = services.store.deleteMemory(context.req.param('id'));
      return deleted ? context.json({ ok: true }) : context.json({ error: 'Not found' }, 404);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.put('/api/memory/:id', async (context) => {
    try {
      const { content } = await context.req.json();
      if (typeof content !== 'string' || !content.trim()) {
        return context.json({ error: 'content is required' }, 400);
      }
      const id = context.req.param('id');
      let embedding: number[] | null = null;
      try {
        embedding = services.providers
          ? await services.providers.get('ollama').embed(content)
          : null;
      } catch {
        // embedding unavailable - store lexically only
      }
      const updated = services.store.updateMemory(id, content.trim(), embedding);
      return updated
        ? context.json({ ok: true, hasEmbedding: Boolean(embedding) })
        : context.json({ error: 'Not found' }, 404);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get('/api/schedules', (context) => context.json({ schedules: services.scheduler.list() }));
  app.get('/api/tasks/:id', (context) => {
    const diagnostics = services.scheduler.inspectTask(context.req.param('id'));
    return diagnostics ? context.json(diagnostics) : context.json({ error: 'Task not found' }, 404);
  });
  app.get('/api/tasks', (context) => context.json({ tasks: services.scheduler.listTasks() }));
  app.post('/api/tasks/:id/cancel', (context) => {
    try {
      services.scheduler.cancelTask(context.req.param('id'));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post('/api/schedules', async (context) => {
    try {
      return context.json(services.scheduler.create(await context.req.json()));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.put('/api/schedules/:id', async (context) => {
    try {
      return context.json(
        services.scheduler.update(context.req.param('id'), await context.req.json()),
      );
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post('/api/schedules/:id/pause', (context) => {
    try {
      services.scheduler.pause(context.req.param('id'));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.post('/api/schedules/:id/resume', (context) => {
    try {
      services.scheduler.resume(context.req.param('id'));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.post('/api/schedules/:id/trigger', async (context) => {
    try {
      await services.scheduler.trigger(context.req.param('id'));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.delete('/api/schedules/:id', (context) => {
    try {
      services.scheduler.deleteSchedule(context.req.param('id'));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.put('/api/schedules/:id', async (context) => {
    try {
      const body = await context.req.json();
      const updated = services.scheduler.update(context.req.param('id'), {
        name: body.name,
        agentInput: body.agentInput,
      });
      return context.json(updated);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.get('/api/skills', (context) => context.json({ skills: services.skills.list() }));
  app.get('/api/skills/:name', (context) => {
    try {
      return context.json(services.skills.load(context.req.param('name')));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.post('/api/skills', async (context) => {
    try {
      const body = (await context.req.json()) as { name?: unknown; instructions?: unknown };
      if (typeof body.name !== 'string' || typeof body.instructions !== 'string')
        return context.json({ error: 'Skill name and instructions are required.' }, 400);
      return context.json(
        await new SkillLearner(services.root, services.skills).create(body.name, body.instructions),
      );
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post('/api/skills/:name/enable', (context) => {
    try {
      services.skills.enable(context.req.param('name'));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.post('/api/skills/:name/disable', (context) => {
    try {
      services.skills.disable(context.req.param('name'));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.get('/api/plugins', (context) =>
    context.json({ plugins: services.plugins.list(), health: services.plugins.health() }),
  );
  app.post('/api/plugins/:name/unload', (context) => {
    try {
      services.plugins.unload(context.req.param('name'));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.post('/api/plugins/:name/disable', (context) => {
    try {
      services.plugins.disable(context.req.param('name'));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.post('/api/plugins/:name/enable', (context) => {
    try {
      services.plugins.enable(context.req.param('name'));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.post('/api/plugins/:name/reload', async (context) => {
    try {
      const plugins = await services.plugins.reload(context.req.param('name'));
      return context.json({ ok: true, plugins });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.post('/api/plugins/:name/config', async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as { config?: unknown };
    if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config))
      return context.json({ error: 'config object is required' }, 400);
    try {
      services.plugins.configure(context.req.param('name'), body.config as Record<string, unknown>);
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.get('/api/secrets', (context) => context.json({ names: services.secrets.listNames() }));
  app.post('/api/secrets', async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as { name?: string; value?: string };
    if (!body.name || !body.value)
      return context.json({ error: 'name and value are required' }, 400);
    services.secrets.set(body.name, body.value);
    return context.json({ ok: true, name: body.name });
  });
  app.delete('/api/secrets/:name', (context) => {
    services.secrets.delete(context.req.param('name'));
    return context.json({ ok: true });
  });

  app.get('/*', async (context) => {
    const requested = context.req.path === '/' ? 'index.html' : context.req.path.replace(/^\//, '');
    const path = resolve(webRoot, requested);
    const safe = path === webRoot || path.startsWith(`${webRoot}/`);
    if (safe) {
      try {
        const response = new Response(await readFile(path), {
          headers: {
            'content-type': contentType(path),
          },
        });
        return response;
      } catch {
        /* fall through to the SPA shell */
      }
    }
    try {
      return new Response(await readFile(resolve(webRoot, 'index.html')), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
        },
      });
    } catch {
      return context.text('NUAAI web build is unavailable. Run npm run build:web.', 503);
    }
  });
  return app;
}

export interface GatewayHandle {
  port: number;
  close(): Promise<void>;
}

export async function startServer(services: GatewayServices): Promise<GatewayHandle> {
  await mkdir(resolve(services.root, '.nuaai/logs'), { recursive: true, mode: 0o700 });
  log(services.root, 'info', `Starting NUAAI server on ${services.host}:${services.port}`);
  const app = createApp(services);
  const httpServer = createServer(async (request, response) => {
    const requestController = new AbortController();
    response.once('close', () => requestController.abort());
    try {
      const declaredLength = Number(request.headers['content-length'] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxRequestBodyBytes) {
        response.statusCode = 413;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.length;
        if (receivedBytes > maxRequestBodyBytes) {
          response.statusCode = 413;
          response.setHeader('content-type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: 'Request body too large' }));
          return;
        }
        chunks.push(buffer);
      }
      const origin = effectiveRequestOrigin(request.socket.remoteAddress, request.rawHeaders);
      const requestUrl = new URL(request.url ?? '/', origin);
      if (requestUrl.origin !== origin) throw new Error('Invalid request target');
      const mountedAtNuaai =
        requestUrl.pathname === '/nuaai' || requestUrl.pathname.startsWith('/nuaai/');
      if (mountedAtNuaai) {
        requestUrl.pathname = requestUrl.pathname.slice('/nuaai'.length) || '/';
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      headers.delete('x-nuaai-internal-mount-path');
      if (mountedAtNuaai) headers.set('x-nuaai-internal-mount-path', '/nuaai');
      const method = request.method ?? 'GET';
      const webRequest = new Request(requestUrl, {
        signal: requestController.signal,
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      const webResponse = await app.fetch(webRequest);
      response.statusCode = webResponse.status;
      webResponse.headers.forEach((value, key) => response.setHeader(key, value));
      response.flushHeaders();
      if (webResponse.body)
        await pipeline(
          Readable.fromWeb(webResponse.body as Parameters<typeof Readable.fromWeb>[0]),
          response,
        );
      else response.end();
    } catch (error) {
      if (requestController.signal.aborted) return;
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const requestPath = request.url?.split('?')[0] ?? '/';
      log(services.root, 'error', `${request.method ?? 'UNKNOWN'} ${requestPath} -> 500`, error);
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(services.port, services.host, () => {
      httpServer.removeListener('error', rejectListen);
      resolveListen();
    });
  });
  log(services.root, 'info', `NUAAI server listening on http://${services.host}:${services.port}`);
  const wsServer = new WebSocketServer({
    server: httpServer,
    maxPayload: maxWebSocketMessageBytes,
  });
  const clients = new Map<WebSocket, string | undefined | null>();
  const unsubscribe = services.runtime.subscribe((event) => {
    const payload = JSON.stringify({ type: 'event', event });
    const approvalInvalidation = event.type.startsWith('approval.')
      ? JSON.stringify({ type: 'approvals.invalidated' })
      : undefined;
    for (const [client, sessionId] of clients) {
      if (client.readyState !== client.OPEN) continue;
      if (approvalInvalidation) client.send(approvalInvalidation);
      if (sessionId === null) continue;
      if (!sessionId || !event.sessionId || sessionId === event.sessionId) client.send(payload);
    }
  });
  wsServer.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/ws', `http://${request.headers.host ?? 'localhost'}`);
    if (!['/ws', '/nuaai/ws'].includes(url.pathname)) {
      socket.close(1008, 'Unknown WebSocket route');
      return;
    }
    if (request.headers.origin) {
      let matched = false;
      try {
        matched = new URL(request.headers.origin).host === request.headers.host;
      } catch {
        matched = false;
      }
      if (!matched) {
        socket.close(1008, 'Origin mismatch');
        return;
      }
    }
    const token =
      url.searchParams.get('token') ??
      request.headers.cookie
        ?.split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('nuaai_token='))
        ?.slice('nuaai_token='.length);
    const checkedAt = (services.now ?? Date.now)();
    if (!token || !isRequestCredential(validateToken(token, services.authSecret, checkedAt))) {
      socket.close(1008, authenticationFailure(token ?? null, services.authSecret, checkedAt).code);
      return;
    }
    clients.set(socket, null);
    socket.send(JSON.stringify({ type: 'ready', version: getVersion() }));
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          sessionId?: string;
          after?: number;
          limit?: number;
        };
        if (message.type === 'subscribe') {
          clients.set(socket, message.sessionId);
          const after = Number.isFinite(message.after)
            ? Math.max(0, Math.trunc(message.after ?? 0))
            : 0;
          const limit = Number.isFinite(message.limit)
            ? Math.min(maxReplayPageSize, Math.max(1, Math.trunc(message.limit ?? 250)))
            : 250;
          const page = message.sessionId
            ? services.store.listEventsForSession(message.sessionId, after, limit)
            : globalEventPage(services.store, after, limit);
          for (const event of page.events) socket.send(JSON.stringify({ type: 'event', event }));
          socket.send(
            JSON.stringify({
              type: 'replay.complete',
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            }),
          );
        }
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'Invalid WebSocket message' }));
      }
    });
    socket.on('close', () => clients.delete(socket));
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : services.port;
  return {
    port,
    close: async () => {
      unsubscribe();
      for (const client of clients.keys()) client.terminate();
      await new Promise<void>((resolveClose) => wsServer.close(() => resolveClose()));
      if (typeof httpServer.closeAllConnections === 'function') {
        httpServer.closeAllConnections();
      }
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
    },
  };
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint)
  void import('./daemon.js')
    .then(({ startDaemon }) => startDaemon())
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
