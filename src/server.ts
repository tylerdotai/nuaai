import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';
import { type WebSocket, WebSocketServer } from 'ws';

import { harnessConfig } from './config/index.js';
import type { AgentRuntime } from './core/runtime.js';
import type { Scheduler } from './core/scheduler.js';
import { validateToken } from './gateway/token.js';
import type { McpManager } from './integrations/mcp.js';
import type { DatabaseStore } from './memory/db.js';
import type { PluginRegistry } from './plugins/registry.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { SecretsManager } from './security/secrets.js';
import type { SkillRegistry } from './skills/registry.js';
import { getVersion } from './version.js';

export interface GatewayServices {
  root: string;
  port: number;
  host: string;
  authSecret: string;
  authToken: string;
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
  const protectedRoute = async (
    context: Parameters<NonNullable<Parameters<Hono['use']>[1]>>[0],
    next: () => Promise<void>,
  ) => {
    const token = tokenFromRequest(context.req.raw);
    if (!token || !validateToken(token, services.authSecret))
      return context.json({ error: 'Unauthorized' }, 401);
    await next();
  };

  app.get('/health', (context) =>
    context.json({ ok: true, name: harnessConfig.name, version: getVersion(), daemon: true }),
  );
  app.get('/version', (context) =>
    context.json({ name: harnessConfig.name, version: getVersion() }),
  );
  app.use('/api/*', protectedRoute);
  app.get('/api/status', async (context) =>
    context.json({
      ...services.runtime.status(),
      providers: await services.runtime.providerHealth(),
    }),
  );
  app.get('/api/sessions', (context) =>
    context.json({ sessions: services.runtime.listSessions() }),
  );
  app.post('/api/sessions', async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as { title?: string };
    return context.json(services.runtime.createSession(body.title));
  });
  app.post('/api/sessions/:id/threads', async (context) => {
    try {
      const body = (await context.req.json().catch(() => ({}))) as { title?: string };
      return context.json({
        thread: services.runtime.createThread(context.req.param('id'), body.title),
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
  app.get('/api/events', (context) => {
    const after = Number(context.req.query('after') ?? 0);
    const sessionId = context.req.query('sessionId');
    const events = services.store
      .listEvents(Number.isFinite(after) ? after : 0, 1000)
      .filter((event) => !sessionId || event.sessionId === sessionId);
    return context.json({ events });
  });
  app.get('/api/providers', async (context) => context.json(await services.providers.catalog()));
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
    const webRoot = fileURLToPath(new URL('../dist/web', import.meta.url));
    const requested = context.req.path === '/' ? 'index.html' : context.req.path.replace(/^\//, '');
    const path = resolve(webRoot, requested);
    const safe = path === webRoot || path.startsWith(`${webRoot}/`);
    if (safe) {
      try {
        const response = new Response(await readFile(path), {
          headers: {
            'content-type': contentType(path),
            'set-cookie': `nuaai_token=${services.authToken}; HttpOnly; SameSite=Strict; Path=/`,
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
          'set-cookie': `nuaai_token=${services.authToken}; HttpOnly; SameSite=Strict; Path=/`,
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
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const url = `http://${request.headers.host ?? `${services.host}:${services.port}`}${request.url ?? '/'}`;
      const requestUrl = new URL(url);
      if (requestUrl.pathname === '/nuaai' || requestUrl.pathname.startsWith('/nuaai/')) {
        requestUrl.pathname = requestUrl.pathname.slice('/nuaai'.length) || '/';
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
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
  const wsServer = new WebSocketServer({ server: httpServer });
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
    if (!token || !validateToken(token, services.authSecret)) {
      socket.close(1008, 'Unauthorized');
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
        };
        if (message.type === 'subscribe') {
          clients.set(socket, message.sessionId);
          for (const event of services.store.listEvents(message.after ?? 0, 1000))
            socket.send(JSON.stringify({ type: 'event', event }));
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
