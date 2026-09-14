import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { BrowserAutomationClient } from '../src/integrations/search.js';

interface ClosableServer {
  close(callback: (error?: Error) => void): void;
}

const servers: ClosableServer[] = [];

async function listen(server: {
  listen(port: number, host: string, callback: () => void): void;
  address(): AddressInfo | string | null;
  close(callback: (error?: Error) => void): void;
}): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address unavailable');
  return address.port;
}

function allowOnly(origin: string) {
  return {
    assertAllowed: async (value: string) => {
      const url = new URL(value);
      if (url.origin !== origin)
        throw new Error('Browser URL must resolve only to public destinations');
      return url;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe('real browser network confinement', () => {
  it('does not follow an HTTP redirect to a private listener', async () => {
    let privateHits = 0;
    const privateServer = createServer((_request, response) => {
      privateHits += 1;
      response.end('private target');
    });
    const privatePort = await listen(privateServer);
    const publicServer = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${privatePort}/secret` });
      response.end();
    });
    const publicPort = await listen(publicServer);
    const publicUrl = `http://127.0.0.1:${publicPort}/start`;
    const client = new BrowserAutomationClient({
      timeoutMs: 10_000,
      urlPolicy: allowOnly(new URL(publicUrl).origin) as never,
    });

    await expect(client.open(publicUrl)).rejects.toThrow('Browser redirects are blocked');
    expect(privateHits).toBe(0);
  }, 20_000);

  it('does not allow a page to connect to a private WebSocket', async () => {
    let acceptedConnections = 0;
    const websocketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    websocketServer.on('connection', (socket) => {
      acceptedConnections += 1;
      socket.send('private data');
      socket.close();
    });
    await new Promise<void>((resolve) => websocketServer.once('listening', resolve));
    servers.push(websocketServer);
    const websocketAddress = websocketServer.address();
    if (!websocketAddress || typeof websocketAddress === 'string')
      throw new Error('WebSocket test server address unavailable');
    const websocketPort = websocketAddress.port;
    const publicServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<body>public page<script>new WebSocket('ws://127.0.0.1:${websocketPort}/secret')</script></body>`,
      );
    });
    const publicPort = await listen(publicServer);
    const publicUrl = `http://127.0.0.1:${publicPort}/`;
    const client = new BrowserAutomationClient({
      timeoutMs: 10_000,
      urlPolicy: allowOnly(new URL(publicUrl).origin) as never,
    });

    await expect(client.open(publicUrl)).resolves.toMatchObject({ text: 'public page' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(acceptedConnections).toBe(0);
  }, 20_000);
});
