import { randomUUID } from 'node:crypto';

export interface MatrixConfig {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  pollTimeoutMs?: number;
}

export interface MatrixMessage {
  roomId: string;
  eventId: string;
  sender: string;
  body: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function apiUrl(homeserverUrl: string, path: string): URL {
  const base = homeserverUrl.endsWith('/') ? homeserverUrl : `${homeserverUrl}/`;
  return new URL(path.replace(/^\//, ''), base);
}

function assertOk(response: Response): void {
  if (!response.ok) throw new Error(`Matrix request failed: ${response.status}`);
}

export function extractMatrixMessages(value: unknown, ownUserId: string): MatrixMessage[] {
  if (!value || typeof value !== 'object') return [];
  const rooms = (value as { rooms?: { join?: Record<string, unknown> } }).rooms?.join ?? {};
  const messages: MatrixMessage[] = [];
  for (const [roomId, room] of Object.entries(rooms)) {
    const events = (room as { timeline?: { events?: unknown[] } }).timeline?.events ?? [];
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const item = event as {
        type?: string;
        sender?: string;
        event_id?: string;
        content?: { msgtype?: string; body?: string };
      };
      if (
        item.type !== 'm.room.message' ||
        item.sender === ownUserId ||
        item.content?.msgtype !== 'm.text' ||
        !item.event_id ||
        !item.sender ||
        !item.content.body?.trim()
      )
        continue;
      messages.push({
        roomId,
        eventId: item.event_id,
        sender: item.sender,
        body: item.content.body,
      });
    }
  }
  return messages;
}

function extractMatrixInvites(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const rooms = (value as { rooms?: { invite?: Record<string, unknown> } }).rooms?.invite ?? {};
  return Object.keys(rooms);
}

export class MatrixBridge {
  private since: string | undefined;
  private running = false;

  constructor(
    private readonly config: MatrixConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async syncOnce(): Promise<MatrixMessage[]> {
    const url = apiUrl(this.config.homeserverUrl, '/_matrix/client/v3/sync');
    url.searchParams.set('timeout', String(this.config.pollTimeoutMs ?? 25_000));
    if (this.since) url.searchParams.set('since', this.since);
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.config.accessToken}` },
      signal: AbortSignal.timeout((this.config.pollTimeoutMs ?? 25_000) + 10_000),
    });
    assertOk(response);
    const value = (await response.json()) as { next_batch?: string };
    if (value.next_batch) this.since = value.next_batch;
    for (const roomId of extractMatrixInvites(value)) await this.joinRoom(roomId);
    return extractMatrixMessages(value, this.config.userId);
  }

  async joinRoom(roomId: string): Promise<void> {
    const url = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
    );
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assertOk(response);
  }

  async sendText(roomId: string, body: string): Promise<{ eventId: string }> {
    if (!body.trim()) throw new Error('Matrix message body is required');
    const txnId = randomUUID();
    const url = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    );
    const response = await this.fetchImpl(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ msgtype: 'm.text', body }),
    });
    assertOk(response);
    const value = (await response.json()) as { event_id?: string };
    if (!value.event_id) throw new Error('Matrix send response did not include event_id');
    return { eventId: value.event_id };
  }

  async start(onMessage: (message: MatrixMessage) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.running) {
      try {
        const messages = await this.syncOnce();
        for (const message of messages) {
          if (this.running) await onMessage(message);
        }
      } catch (error) {
        if (!this.running) break;
        process.stderr.write(
          `Matrix sync unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}
