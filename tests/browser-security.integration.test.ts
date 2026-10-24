import { createHash } from 'node:crypto';
import { type IncomingMessage, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

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

function acceptWebSocket(socket: Duplex, key: string): void {
  const accept = createHash('sha1')
    .update(key)
    .update('258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

function startMinimalWebSocketServer(handler: (socket: Duplex) => void): Promise<{
  close(callback: (error?: Error) => void): void;
  port: number;
}> {
  const server = createServer();
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, _head: Buffer) => {
    if (request.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    acceptWebSocket(socket, key);
    handler(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('WebSocket test server address unavailable');
      }
      servers.push(server);
      resolve({ close: server.close.bind(server), port: address.port });
    });
  });
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
    const websocketServer = await startMinimalWebSocketServer((socket) => {
      acceptedConnections += 1;
      socket.write('private data');
      socket.end();
    });
    const websocketPort = websocketServer.port;
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
