import type { Hono } from 'hono';
import { z } from 'zod';
import { type VoiceBroker, VoiceError, safeVoiceError } from './broker.js';
import { voiceLimits } from './types.js';

const control = { generation: z.number().int().positive() };
const startSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
    requestId: z.string().min(1).max(256),
    offer: z.object({ type: z.literal('offer'), sdp: z.string().min(1) }).strict(),
  })
  .strict();
const heartbeatSchema = z
  .object({
    ...control,
    observation: z
      .object({
        peerState: z.enum(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
        muted: z.boolean(),
        playback: z.enum(['unknown', 'blocked', 'playing', 'stopped']),
      })
      .strict(),
  })
  .strict();
const stopSchema = z
  .object({ ...control, reason: z.enum(['hangup', 'navigation', 'client_error']) })
  .strict();
const interruptSchema = z.object({ ...control, requestId: z.string().min(1).max(256) }).strict();

async function body(request: Request): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    throw new VoiceError('VOICE_INVALID_REQUEST', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new VoiceError('VOICE_INVALID_REQUEST', 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > voiceLimits.maxBodyBytes) throw new VoiceError('VOICE_PAYLOAD_TOO_LARGE', 413);
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof VoiceError ? error : new VoiceError('VOICE_INVALID_REQUEST', 400);
  } finally {
    reader.releaseLock();
  }
}

/** Mounted after normal daemon authentication. Credential callback must validate, never trust IDs. */
export function installVoiceRoutes(
  app: Hono,
  broker: VoiceBroker,
  credential: (request: Request) => { owner: string; expiresAt: number },
): void {
  app.use('/api/voice/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    try {
      const request = context.req.raw;
      const url = new URL(request.url);
      if (url.searchParams.has('token')) throw new VoiceError('VOICE_FORBIDDEN', 403);
      const origin = request.headers.get('origin');
      const bearer = request.headers.get('authorization')?.startsWith('Bearer ');
      let validOrigin = origin === null;
      if (origin !== null) {
        try {
          validOrigin = origin === new URL(origin).origin && origin === url.origin;
        } catch {
          validOrigin = false;
        }
      }
      const forwarded = request.headers.get('x-forwarded-proto');
      if (
        !validOrigin ||
        (forwarded !== null && forwarded !== 'http' && forwarded !== 'https') ||
        (!bearer && request.method !== 'GET' && !origin) ||
        request.headers.get('sec-fetch-site') === 'cross-site'
      )
        throw new VoiceError('VOICE_FORBIDDEN', 403);
      credential(request);
      await next();
    } catch (error) {
      const failure =
        error instanceof z.ZodError
          ? new VoiceError('VOICE_INVALID_REQUEST', 400)
          : safeVoiceError(error);
      return context.json({ error: failure.safe() }, failure.status as 400);
    }
  });
  // Route handlers catch locally: Hono's global error handler must never serialize raw errors.
  app.get('/api/voice/capabilities', (context) => context.json(broker.capabilities()));
  app.post('/api/voice/sessions', async (context) => {
    try {
      const request = startSchema.parse(await body(context.req.raw));
      if (Buffer.byteLength(request.offer.sdp) > voiceLimits.maxSdpBytes)
        throw new VoiceError('VOICE_PAYLOAD_TOO_LARGE', 413);
      const auth = credential(context.req.raw);
      return context.json(await broker.start(auth.owner, request, auth.expiresAt), 201);
    } catch (error) {
      const failure =
        error instanceof z.ZodError
          ? new VoiceError('VOICE_INVALID_REQUEST', 400)
          : safeVoiceError(error);
      return context.json({ error: failure.safe() }, failure.status as 400);
    }
  });
  app.get('/api/voice/sessions/:id', (context) => {
    try {
      return context.json(broker.get(credential(context.req.raw).owner, context.req.param('id')));
    } catch (error) {
      const failure = safeVoiceError(error);
      return context.json({ error: failure.safe() }, failure.status as 400);
    }
  });
  app.post('/api/voice/sessions/:id/heartbeat', async (context) => {
    try {
      const request = heartbeatSchema.parse(await body(context.req.raw));
      return context.json(
        broker.heartbeat(credential(context.req.raw).owner, context.req.param('id'), request),
      );
    } catch (error) {
      const failure =
        error instanceof z.ZodError
          ? new VoiceError('VOICE_INVALID_REQUEST', 400)
          : safeVoiceError(error);
      return context.json({ error: failure.safe() }, failure.status as 400);
    }
  });
  app.post('/api/voice/sessions/:id/stop', async (context) => {
    try {
      const request = stopSchema.parse(await body(context.req.raw));
      return context.json(
        await broker.stop(
          credential(context.req.raw).owner,
          context.req.param('id'),
          request.generation,
        ),
      );
    } catch (error) {
      const failure =
        error instanceof z.ZodError
          ? new VoiceError('VOICE_INVALID_REQUEST', 400)
          : safeVoiceError(error);
      return context.json({ error: failure.safe() }, failure.status as 400);
    }
  });
  app.post('/api/voice/sessions/:id/interrupt', async (context) => {
    try {
      const request = interruptSchema.parse(await body(context.req.raw));
      return context.json({
        voice: await broker.interrupt(
          credential(context.req.raw).owner,
          context.req.param('id'),
          request.generation,
        ),
        status: 'accepted',
      });
    } catch (error) {
      const failure =
        error instanceof z.ZodError
          ? new VoiceError('VOICE_INVALID_REQUEST', 400)
          : safeVoiceError(error);
      return context.json({ error: failure.safe() }, failure.status as 400);
    }
  });
  app.get('/api/voice/sessions/:id/events', (context) => {
    try {
      const auth = credential(context.req.raw);
      const id = context.req.param('id');
      const after = Number(
        context.req.header('Last-Event-ID') ?? context.req.query('after') ?? '0',
      );
      const initial = broker.events(auth.owner, id, after);
      const encoder = new TextEncoder();
      let dispose = () => {};
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            let closed = false;
            const cleanup = () => {
              if (closed) return;
              closed = true;
              unsubscribe();
              clearInterval(timer);
              clearTimeout(expiry);
              context.req.raw.signal.removeEventListener('abort', cleanup);
              try {
                controller.close();
              } catch {
                /* Reader cancellation already closed the stream. */
              }
            };
            const send = (event: ReturnType<VoiceBroker['events']>[number]) => {
              if (closed) return;
              if ((controller.desiredSize ?? 0) <= 0) {
                cleanup();
                return;
              }
              controller.enqueue(
                encoder.encode(
                  `id: ${event.seq}\nevent: voice\ndata: ${JSON.stringify(event)}\n\n`,
                ),
              );
              if (
                event.type === 'voice.state' &&
                ['closed', 'failed'].includes(event.payload.phase)
              )
                cleanup();
            };
            const unsubscribe = broker.subscribe(auth.owner, id, send);
            const timer = setInterval(() => {
              if (context.req.raw.signal.aborted) cleanup();
              else if ((controller.desiredSize ?? 0) > 0)
                controller.enqueue(encoder.encode(': heartbeat\n\n'));
              else cleanup();
            }, 10_000);
            const expiry = setTimeout(
              cleanup,
              Math.max(0, Math.min(voiceLimits.maxDurationMs, auth.expiresAt - Date.now())),
            );
            dispose = cleanup;
            context.req.raw.signal.addEventListener('abort', cleanup, { once: true });
            for (const event of initial) send(event);
            if (context.req.raw.signal.aborted) cleanup();
          },
          cancel() {
            dispose();
          },
        },
        { highWaterMark: 256 },
      );
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        },
      });
    } catch (error) {
      const failure = safeVoiceError(error);
      return context.json({ error: failure.safe() }, failure.status as 400);
    }
  });
}
