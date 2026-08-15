import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { harnessConfig } from './config/index.js';
import { getVersion } from './version.js';

export const app = new Hono();

app.get('/health', (context) =>
  context.json({ ok: true, name: harnessConfig.name, version: getVersion() }),
);

app.get('/version', (context) => context.json({ name: harnessConfig.name, version: getVersion() }));

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const port = Number.parseInt(process.env.NUAI_PORT ?? '8787', 10);
  serve({ fetch: app.fetch, port: Number.isFinite(port) ? port : 8787 });
}
