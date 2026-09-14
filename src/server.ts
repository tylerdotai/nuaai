import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';
import { type WebSocket, WebSocketServer } from 'ws';

import { harnessConfig } from './config/index.js';
import type { AgentRuntime } from './core/runtime.js';
import type { Scheduler } from './core/scheduler.js';
import { createToken, inspectToken, validateToken } from './gateway/token.js';
import type { McpManager } from './integrations/mcp.js';
import type { DatabaseStore, EventPage, RunRow } from './memory/db.js';
import type { PluginRegistry } from './plugins/registry.js';
import type { ProviderRegistry } from './providers/registry.js';
import {
  type PermissionContext,
  type PermissionProfile,
  permissionContextForProfile,
} from './security/permissions.js';
import type { SecretsManager } from './security/secrets.js';
import type { SkillRegistry } from './skills/registry.js';
import { getVersion } from './version.js';
import { buildThreadPresentation } from './web/presentation.js';

const maxRequestBodyBytes = 1024 * 1024;
const maxWebSocketMessageBytes = 64 * 1024;
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
  providers: ProviderRegistry;
  scheduler: Scheduler;
  skills: SkillRegistry;
  plugins: PluginRegistry;
  secrets: SecretsManager;
  mcp?: McpManager;
}

function tokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
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
  app.get('/api/status', async (context) =>
    context.json({
      ...services.runtime.status(),
      providers: await services.runtime.providerHealth(),
      webPermissionProfile: runPermissionProfile,
    }),
  );
  app.get('/api/sessions', (context) =>
    context.json({
      sessions: services.runtime.listSessions(context.req.query('includeOrphans') === 'true'),
    }),
  );
  app.post('/api/sessions', async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      title?: string;
      sourceKey?: string;
    };
    return context.json(services.runtime.createSession(body.title, body.sourceKey));
  });
  app.post('/api/sessions/resolve', async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      title?: string;
      sourceKey?: string;
    };
    if (!body.sourceKey?.trim()) return context.json({ error: 'sourceKey is required' }, 400);
    return context.json(services.runtime.getOrCreateSession(body.sourceKey, body.title));
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
      ? context.json({ session, threads: services.runtime.listThreads(session.id) })
      : context.json({ error: 'Session not found' }, 404);
  });
  app.post('/api/sessions/:id/switch', (context) => {
    const session = services.runtime.getSession(context.req.param('id'));
    return session
      ? context.json({ session, threads: services.runtime.listThreads(session.id), active: true })
      : context.json({ error: 'Session not found' }, 404);
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
    if (!services.store.getThread(threadId))
      return context.json({ error: 'Thread not found' }, 404);
    const activeRuns = services.store.listActiveRunsForThread(threadId);
    const run = activeRuns[0] ?? services.store.getLatestRun(threadId);
    const events = run ? services.store.listRecentEventsForRun(run.id, runSnapshotEventLimit) : [];
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
      lastEventId: events.at(-1)?.id ?? 0,
    });
  });
  app.post('/api/runs', async (context) => {
    const body = (await context.req.json()) as {
      threadId?: string;
      input?: string;
      provider?: string;
      model?: string;
    };
    if (!body.threadId || !body.input)
      return context.json({ error: 'threadId and input are required' }, 400);
    try {
      return context.json(
        services.runtime.startRun({
          threadId: body.threadId,
          input: body.input,
          provider: body.provider,
          model: body.model,
          permissions: runPermissions,
        }),
      );
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post('/api/runs/:id/resume', (context) => {
    try {
      return context.json(services.runtime.resumeRun(context.req.param('id')));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
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
    if (!['queued', 'running'].includes(run.status))
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
  app.get('/api/memory', (context) =>
    context.json({
      memories: services.store
        .searchMemoryRows()
        .map(({ embedding, ...memory }) => ({ ...memory, hasEmbedding: Boolean(embedding) })),
    }),
  );
  app.get('/api/schedules', (context) => context.json({ schedules: services.scheduler.list() }));
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
  app.get('/api/skills', (context) => context.json({ skills: services.skills.list() }));
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
  const app = createApp(services);
  const httpServer = createServer(async (request, response) => {
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
      const url = `http://${request.headers.host ?? `${services.host}:${services.port}`}${request.url ?? '/'}`;
      const requestUrl = new URL(url);
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
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      const webResponse = await app.fetch(webRequest);
      response.statusCode = webResponse.status;
      webResponse.headers.forEach((value, key) => response.setHeader(key, value));
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch (error) {
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
  const wsServer = new WebSocketServer({
    server: httpServer,
    maxPayload: maxWebSocketMessageBytes,
  });
  const clients = new Map<WebSocket, string | undefined>();
  const unsubscribe = services.runtime.subscribe((event) => {
    const payload = JSON.stringify({ type: 'event', event });
    for (const [client, sessionId] of clients)
      if (
        client.readyState === client.OPEN &&
        (!sessionId || !event.sessionId || sessionId === event.sessionId)
      )
        client.send(payload);
  });
  wsServer.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/ws', `http://${request.headers.host ?? 'localhost'}`);
    if (!['/ws', '/nuaai/ws'].includes(url.pathname)) {
      socket.close(1008, 'Unknown WebSocket route');
      return;
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
    clients.set(socket, undefined);
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
      for (const client of clients.keys()) client.close();
      await new Promise<void>((resolveClose) =>
        wsServer.close(() => {
          httpServer.close(() => resolveClose());
        }),
      );
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
