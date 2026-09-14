import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { assertSafeProjectFile } from '../workspace/fs.js';

export interface MatrixConfig {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  pollTimeoutMs?: number;
  retryDelayMs?: number;
  since?: string;
  onSince?: (since: string) => void | Promise<void>;
  downloadDirectory?: string;
  workspaceRoot?: string;
  maxAttachmentBytes?: number;
  allowedUsers?: string[];
  allowedRooms?: string[];
  freeResponseRooms?: string[];
  ignoreUserPatterns?: string[];
  requireMention?: boolean;
  processNotices?: boolean;
  allowRoomMentions?: boolean;
  autoThread?: boolean;
  reactions?: boolean;
  maxMessageLength?: number;
}

export interface MatrixAttachment {
  name: string;
  mxcUrl: string;
  mimeType?: string;
  size?: number;
  localPath?: string;
  error?: string;
}

export interface MatrixMessage {
  roomId: string;
  eventId: string;
  sender: string;
  body: string;
  threadRootEventId?: string;
  attachments?: MatrixAttachment[];
}

export function matrixConversationThreadSourceKey(
  sourceKey: string,
  message: Pick<MatrixMessage, 'threadRootEventId'>,
  autoThread: boolean,
): string {
  return autoThread ? `${sourceKey}:main` : `${sourceKey}:${message.threadRootEventId ?? 'main'}`;
}

export function matrixReplyOptions(
  message: Pick<MatrixMessage, 'eventId' | 'threadRootEventId'>,
): MatrixRelationOptions {
  return {
    ...(message.threadRootEventId ? { threadRootEventId: message.threadRootEventId } : {}),
    transactionId: `event-${Buffer.from(message.eventId).toString('base64url')}-reply`,
  };
}

export interface MatrixRelationOptions {
  threadRootEventId?: string;
  transactionId?: string;
}

interface MatrixMessageExtractionOptions {
  allowedUsers?: string[];
  allowedRooms?: string[];
  freeResponseRooms?: string[];
  ignoreUserPatterns?: string[];
  requireMention?: boolean;
  processNotices?: boolean;
  allowRoomMentions?: boolean;
  minimumTimestampMs?: number;
}

export interface MatrixCommand {
  name: string;
  args: string[];
}

export function parseMatrixCommand(body: string): MatrixCommand | undefined {
  const value = body.trim();
  if (!value.startsWith('/')) return undefined;
  const tokens = value.slice(1).trim().split(/\s+/).filter(Boolean);
  return { name: (tokens.shift() ?? '').toLowerCase(), args: tokens };
}

export function matrixHelpText(): string {
  return [
    '**NUAAI Matrix commands**',
    '`/help` — show this help',
    '`/status` — show the active session',
    '`/sessions` — list sessions available in this room',
    '`/new [title]` — start a fresh session',
    '`/switch <session-id>` — switch the active session',
    '`/voice on|off|status` — control microphone/audio transcription',
    '`/tts on|off|status` — control spoken responses',
    '',
    'Send any other text to run it through NUAAI.',
  ].join('\n');
}

export function matrixProgressText(eventType: string, name: string): string | undefined {
  if (eventType === 'tool.failed') return `⚠️ ${name} failed`;
  if (eventType === 'run.failed') return `⚠️ NUAAI run failed: ${name}`;
  if (eventType === 'run.cancelled') return '🛑 NUAAI run cancelled';
  return undefined;
}

export function matrixTerminalProgress(status: string): string | undefined {
  return status === 'completed' ? undefined : `⚠️ NUAAI ${status}`;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type MatrixEndpoint =
  | 'sync'
  | 'join'
  | 'receipt'
  | 'typing'
  | 'message'
  | 'reaction'
  | 'redaction'
  | 'media-upload'
  | 'media-download'
  | 'request';

export class MatrixRequestError extends Error {
  readonly status: number;
  readonly errcode: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly endpoint: MatrixEndpoint;

  constructor(options: {
    status: number;
    endpoint: MatrixEndpoint;
    errcode?: string;
    retryAfterMs?: number;
    detail?: string;
  }) {
    const fields = [`status=${options.status}`];
    if (options.errcode) fields.push(`errcode=${options.errcode}`);
    if (options.retryAfterMs !== undefined) fields.push(`retry_after_ms=${options.retryAfterMs}`);
    if (options.detail) fields.push(`message=${options.detail}`);
    super(`Matrix ${options.endpoint} request failed: ${fields.join(' ')}`);
    this.name = 'MatrixRequestError';
    this.status = options.status;
    this.errcode = options.errcode;
    this.retryAfterMs = options.retryAfterMs;
    this.endpoint = options.endpoint;
  }
}

function apiUrl(homeserverUrl: string, path: string): URL {
  const base = homeserverUrl.endsWith('/') ? homeserverUrl : `${homeserverUrl}/`;
  return new URL(path.replace(/^\//, ''), base);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}

function inlineMarkdown(value: string): string {
  const codeSpans: string[] = [];
  let html = escapeHtml(value);
  html = html.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const marker = `@@NUAAICODE${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return marker;
  });
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');
  return html.replace(
    /@@NUAAICODE(\d+)@@/g,
    (_match, index: string) => codeSpans[Number(index)] ?? '',
  );
}

export function formatMatrixBody(body: string): {
  format: 'org.matrix.custom.html';
  formattedBody: string;
} {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let list: 'ol' | 'ul' | undefined;
  let fenced = false;
  let code: string[] = [];
  const closeList = (): void => {
    if (list) html.push(`</${list}>`);
    list = undefined;
  };
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (fenced) {
        html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = [];
      }
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const nextList = unordered ? 'ul' : 'ol';
      if (list !== nextList) {
        closeList();
        html.push(`<${nextList}>`);
        list = nextList;
      }
      html.push(`<li>${inlineMarkdown((unordered ?? ordered)?.[1] ?? '')}</li>`);
      continue;
    }
    closeList();
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[0].trimStart().split(/\s/, 1)[0].length, 6);
      html.push(`<h${level}>${inlineMarkdown(heading[1])}</h${level}>`);
    } else html.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (fenced) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  closeList();
  return { format: 'org.matrix.custom.html', formattedBody: html.join('') };
}

function endpointCategory(url: URL): MatrixEndpoint {
  const path = url.pathname;
  if (path.endsWith('/sync')) return 'sync';
  if (path.includes('/join/')) return 'join';
  if (path.includes('/receipt/')) return 'receipt';
  if (path.includes('/typing/')) return 'typing';
  if (path.includes('/send/m.reaction/')) return 'reaction';
  if (path.includes('/send/m.room.message/')) return 'message';
  if (path.includes('/redact/')) return 'redaction';
  if (path.endsWith('/upload')) return 'media-upload';
  if (path.includes('/download/')) return 'media-download';
  return 'request';
}

function sanitizeMatrixDetail(value: unknown, secrets: string[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let sanitized = value.replace(/[\r\n\t]+/gu, ' ').trim();
  for (const secret of secrets) if (secret) sanitized = sanitized.split(secret).join('[REDACTED]');
  return sanitized.length <= 200 ? sanitized : `${sanitized.slice(0, 199)}…`;
}

async function matrixRequestError(
  response: Response,
  endpoint: MatrixEndpoint,
  secrets: string[],
): Promise<MatrixRequestError> {
  const payload = (await response
    .clone()
    .json()
    .catch(() => ({}))) as { errcode?: unknown; retry_after_ms?: unknown; error?: unknown };
  const retryAfterMs = Number(payload.retry_after_ms);
  const detail = sanitizeMatrixDetail(payload.error, secrets);
  const errcode = sanitizeMatrixDetail(payload.errcode, secrets);
  return new MatrixRequestError({
    status: response.status,
    endpoint,
    ...(errcode && /^M_[A-Z0-9_]{1,78}$/u.test(errcode) ? { errcode } : {}),
    ...(Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
    ...(detail ? { detail } : {}),
  });
}

export function extractMatrixMessages(
  value: unknown,
  ownUserId: string,
  options: MatrixMessageExtractionOptions = {},
): MatrixMessage[] {
  if (!value || typeof value !== 'object') return [];
  const rooms = (value as { rooms?: { join?: Record<string, unknown> } }).rooms?.join ?? {};
  const messages: MatrixMessage[] = [];
  const ignoredUserPatterns = (options.ignoreUserPatterns ?? []).map(
    (pattern) => new RegExp(pattern),
  );
  for (const [roomId, room] of Object.entries(rooms)) {
    const events = (room as { timeline?: { events?: unknown[] } }).timeline?.events ?? [];
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const item = event as {
        type?: string;
        sender?: string;
        event_id?: string;
        origin_server_ts?: number;
        content?: {
          msgtype?: string;
          body?: string;
          url?: string;
          filename?: string;
          info?: { mimetype?: string; size?: number };
          file?: { url?: string; name?: string; mimetype?: string; size?: number };
          'm.relates_to'?: { rel_type?: string; event_id?: string };
          'm.mentions'?: { user_ids?: unknown[]; room?: boolean };
        };
      };
      const content = item.content;
      if (
        options.minimumTimestampMs !== undefined &&
        typeof item.origin_server_ts === 'number' &&
        item.origin_server_ts < options.minimumTimestampMs
      )
        continue;
      if (options.allowedRooms?.length && !options.allowedRooms.includes(roomId)) continue;
      const sender = item.sender ?? '';
      if (options.allowedUsers?.length && !options.allowedUsers.includes(sender)) continue;
      if (sender && ignoredUserPatterns.some((pattern) => pattern.test(sender))) continue;
      if (content?.msgtype === 'm.notice' && !options.processNotices) continue;
      if (content?.['m.relates_to']?.rel_type === 'm.replace') continue;
      const mentionedUserIds = (content?.['m.mentions']?.user_ids ?? []).filter(
        (userId): userId is string => typeof userId === 'string',
      );
      const mentioned = content?.body?.includes(ownUserId) || mentionedUserIds.includes(ownUserId);
      const roomMentioned =
        content?.['m.mentions']?.room === true || content?.body?.split(/\s+/).includes('@room');
      if (
        options.requireMention &&
        !options.freeResponseRooms?.includes(roomId) &&
        !mentioned &&
        !(options.allowRoomMentions && roomMentioned)
      )
        continue;
      const threadRootEventId =
        content?.['m.relates_to']?.rel_type === 'm.thread'
          ? content['m.relates_to'].event_id
          : undefined;
      const attachmentUrl = content?.url ?? content?.file?.url;
      const attachmentName =
        content?.filename || content?.file?.name || content?.body || 'attachment';
      const attachments =
        attachmentUrl &&
        ['m.file', 'm.image', 'm.audio', 'm.video', 'm.sticker'].includes(content?.msgtype ?? '')
          ? [
              {
                name: attachmentName,
                mxcUrl: attachmentUrl,
                ...(content?.info?.mimetype || content?.file?.mimetype
                  ? { mimeType: content.info?.mimetype ?? content.file?.mimetype }
                  : {}),
                ...(content?.info?.size || content?.file?.size
                  ? { size: content.info?.size ?? content.file?.size }
                  : {}),
              },
            ]
          : [];
      if (
        item.type !== 'm.room.message' ||
        item.sender === ownUserId ||
        !content ||
        !item.event_id ||
        !item.sender
      )
        continue;
      if (content.msgtype !== 'm.text' && content.msgtype !== 'm.notice' && !attachments.length)
        continue;
      if (!content.body?.trim() && !attachments.length) continue;
      messages.push({
        roomId,
        eventId: item.event_id,
        sender: item.sender,
        body:
          content.body?.trim() ||
          attachments.map((attachment) => `[Attachment: ${attachment.name}]`).join('\n'),
        ...(threadRootEventId ? { threadRootEventId } : {}),
        ...(attachments.length ? { attachments } : {}),
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

function safeAttachmentName(name: string): string {
  const value = [...basename(name)]
    .map((character) => (character.charCodeAt(0) < 32 || character === '\\' ? '_' : character))
    .join('')
    .trim()
    .replace(/^\.+/, '');
  return value || 'attachment';
}

function matrixMediaUrl(homeserverUrl: string, mxcUrl: string): URL {
  if (!mxcUrl.startsWith('mxc://')) throw new Error('Unsupported Matrix media URL');
  const [server, mediaId] = mxcUrl.slice('mxc://'.length).split('/', 2);
  if (!server || !mediaId) throw new Error('Malformed Matrix media URL');
  return apiUrl(
    homeserverUrl,
    `/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`,
  );
}

function splitMatrixBody(body: string, maxLength: number): string[] {
  if (body.length <= maxLength) return [body];
  const chunks: string[] = [];
  let remaining = body;
  while (remaining.length > maxLength) {
    const newline = remaining.lastIndexOf('\n', maxLength);
    const boundary = newline >= Math.floor(maxLength / 2) ? newline : maxLength;
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

export class MatrixBridge {
  private since: string | undefined;
  private pendingSince: string | undefined;
  private running = false;
  private hasSynced = false;
  private readonly startupTimestampMs = Date.now();
  private readonly seenEventIds = new Set<string>();

  constructor(
    private readonly config: MatrixConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timing: {
      sleep?: (delayMs: number) => Promise<void>;
      random?: () => number;
    } = {},
  ) {
    this.since = config.since;
  }

  private async request(url: URL, init?: RequestInit): Promise<Response> {
    const maxRetries = 2;
    const endpoint = endpointCategory(url);
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (error) {
        throw new MatrixRequestError({
          status: 0,
          endpoint,
          ...(sanitizeMatrixDetail(error instanceof Error ? error.message : String(error), [
            this.config.accessToken,
          ])
            ? {
                detail: sanitizeMatrixDetail(
                  error instanceof Error ? error.message : String(error),
                  [this.config.accessToken],
                ),
              }
            : {}),
        });
      }
      if (response.ok) return response;
      if (response.status !== 429 || attempt >= maxRetries)
        throw await matrixRequestError(response, endpoint, [this.config.accessToken]);
      const payload = (await response
        .clone()
        .json()
        .catch(() => ({}))) as { retry_after_ms?: unknown };
      const retryAfterHeader = response.headers.get('retry-after');
      const headerDelay = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader) * 1_000;
      const payloadDelay = Number(payload.retry_after_ms);
      const retryDelayMs = Math.max(
        0,
        Math.trunc(
          Number.isFinite(payloadDelay)
            ? payloadDelay
            : Number.isFinite(headerDelay)
              ? headerDelay
              : 500,
        ),
      );
      const randomValue = Math.min(1, Math.max(0, this.timing.random?.() ?? Math.random()));
      const jitterMs = Math.min(1_000, Math.floor(retryDelayMs * 0.1 * randomValue));
      await (
        this.timing.sleep ??
        ((delayMs: number) =>
          new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs)))
      )(retryDelayMs + jitterMs);
    }
  }

  async syncOnce(): Promise<MatrixMessage[]> {
    const initialSync = !this.hasSynced && !this.since;
    const url = apiUrl(this.config.homeserverUrl, '/_matrix/client/v3/sync');
    url.searchParams.set('timeout', String(this.config.pollTimeoutMs ?? 25_000));
    if (this.since) url.searchParams.set('since', this.since);
    const response = await this.request(url, {
      headers: { authorization: `Bearer ${this.config.accessToken}` },
      signal: AbortSignal.timeout((this.config.pollTimeoutMs ?? 25_000) + 10_000),
    });
    const value = (await response.json()) as { next_batch?: string };
    if (value.next_batch) this.pendingSince = value.next_batch;
    for (const roomId of extractMatrixInvites(value)) await this.joinRoom(roomId);
    const extracted = extractMatrixMessages(value, this.config.userId, {
      allowedUsers: this.config.allowedUsers,
      allowedRooms: this.config.allowedRooms,
      freeResponseRooms: this.config.freeResponseRooms,
      ignoreUserPatterns: this.config.ignoreUserPatterns,
      requireMention: this.config.requireMention,
      processNotices: this.config.processNotices,
      allowRoomMentions: this.config.allowRoomMentions,
      ...(initialSync ? { minimumTimestampMs: this.startupTimestampMs - 5_000 } : {}),
    });
    const messages = extracted.filter((message) => {
      if (this.seenEventIds.has(message.eventId)) return false;
      this.seenEventIds.add(message.eventId);
      if (this.seenEventIds.size > 8_192) {
        const oldest = this.seenEventIds.values().next().value;
        if (oldest) this.seenEventIds.delete(oldest);
      }
      return true;
    });
    if (!this.config.downloadDirectory) return messages;
    for (const message of messages) {
      if (!message.attachments) continue;
      for (const attachment of message.attachments) {
        try {
          Object.assign(attachment, await this.downloadAttachment(attachment));
        } catch (error) {
          attachment.error = error instanceof Error ? error.message : String(error);
        }
      }
    }
    return messages;
  }

  private async downloadAttachment(attachment: MatrixAttachment): Promise<{ localPath: string }> {
    const response = await this.request(
      matrixMediaUrl(this.config.homeserverUrl, attachment.mxcUrl),
      {
        headers: { authorization: `Bearer ${this.config.accessToken}` },
      },
    );
    const limit = this.config.maxAttachmentBytes ?? 50_000_000;
    const advertised = Number(response.headers.get('content-length') ?? 0);
    if (advertised > limit) throw new Error('Matrix attachment exceeds the configured size limit');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit)
      throw new Error('Matrix attachment exceeds the configured size limit');
    await mkdir(this.config.downloadDirectory as string, { recursive: true, mode: 0o700 });
    const target = resolve(
      this.config.downloadDirectory as string,
      `${randomUUID()}-${safeAttachmentName(attachment.name)}`,
    );
    await writeFile(target, bytes, { mode: 0o600 });
    return { localPath: target };
  }

  async joinRoom(roomId: string): Promise<void> {
    const url = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
    );
    await this.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  }

  async sendReceipt(roomId: string, eventId: string): Promise<void> {
    const url = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
    );
    await this.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  }

  async setTyping(roomId: string, typing: boolean): Promise<void> {
    const url = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.config.userId)}`,
    );
    await this.request(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ typing, timeout: typing ? 30_000 : 0 }),
    });
  }

  private async sendTextChunk(
    roomId: string,
    body: string,
    options: MatrixRelationOptions = {},
  ): Promise<{ eventId: string }> {
    const formatted = formatMatrixBody(body);
    const txnId = options.transactionId ?? randomUUID();
    const url = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    );
    const response = await this.request(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        msgtype: 'm.text',
        body,
        format: formatted.format,
        formatted_body: formatted.formattedBody,
        ...(options.threadRootEventId
          ? {
              'm.relates_to': {
                rel_type: 'm.thread',
                event_id: options.threadRootEventId,
                'm.in_reply_to': { event_id: options.threadRootEventId },
              },
            }
          : {}),
      }),
    });
    const value = (await response.json()) as { event_id?: string };
    if (!value.event_id) throw new Error('Matrix send response did not include event_id');
    return { eventId: value.event_id };
  }

  async sendText(
    roomId: string,
    body: string,
    options: MatrixRelationOptions = {},
  ): Promise<{ eventId: string }> {
    if (!body.trim()) throw new Error('Matrix message body is required');
    let lastEventId = '';
    for (const [index, chunk] of splitMatrixBody(
      body,
      this.config.maxMessageLength ?? 16_000,
    ).entries())
      lastEventId = (
        await this.sendTextChunk(roomId, chunk, {
          ...options,
          ...(options.transactionId ? { transactionId: `${options.transactionId}-${index}` } : {}),
        })
      ).eventId;
    return { eventId: lastEventId };
  }

  async sendReaction(roomId: string, eventId: string, key: string): Promise<{ eventId: string }> {
    if (!key.trim()) throw new Error('Matrix reaction key is required');
    const url = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${randomUUID()}`,
    );
    const response = await this.request(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
      }),
    });
    const value = (await response.json()) as { event_id?: string };
    if (!value.event_id) throw new Error('Matrix reaction response did not include event_id');
    return { eventId: value.event_id };
  }

  async redact(roomId: string, eventId: string): Promise<void> {
    const url = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${randomUUID()}`,
    );
    await this.request(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  }

  async editText(roomId: string, eventId: string, body: string): Promise<void> {
    if (!body.trim()) throw new Error('Matrix edit body is required');
    const formatted = formatMatrixBody(body);
    const newContent = {
      msgtype: 'm.text',
      body,
      format: formatted.format,
      formatted_body: formatted.formattedBody,
    };
    const url = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${randomUUID()}`,
    );
    await this.request(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...newContent,
        body: `* ${body}`,
        formatted_body: `* ${formatted.formattedBody}`,
        'm.new_content': newContent,
        'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
      }),
    });
  }

  async sendFile(
    roomId: string,
    path: string,
    options: MatrixRelationOptions & {
      msgtype?: 'm.file' | 'm.audio';
      mimeType?: string;
      voice?: boolean;
    } = {},
  ): Promise<{ eventId: string }> {
    const root = this.config.workspaceRoot ? resolve(this.config.workspaceRoot) : undefined;
    const target = root ? await assertSafeProjectFile(root, path) : resolve(path);
    const file = await stat(target);
    if (!file.isFile()) throw new Error(`Not a regular file: ${path}`);
    const bytes = await readFile(target);
    const max = this.config.maxAttachmentBytes ?? 50_000_000;
    if (bytes.byteLength > max)
      throw new Error('Outbound Matrix attachment exceeds the configured size limit');
    const upload = apiUrl(this.config.homeserverUrl, '/_matrix/media/v3/upload');
    upload.searchParams.set('filename', basename(target));
    const uploadResponse = await this.request(upload, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/octet-stream',
      },
      body: bytes,
    });
    const uploaded = (await uploadResponse.json()) as { content_uri?: string };
    if (!uploaded.content_uri) throw new Error('Matrix media upload did not return content_uri');
    const sendUrl = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${options.transactionId ?? randomUUID()}`,
    );
    const sendResponse = await this.request(sendUrl, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        msgtype: options.msgtype ?? 'm.file',
        body: basename(target),
        filename: basename(target),
        url: uploaded.content_uri,
        info: {
          size: bytes.byteLength,
          ...(options.mimeType ? { mimetype: options.mimeType } : {}),
        },
        ...(options.voice ? { 'org.matrix.msc3245.voice': true } : {}),
        ...(options.threadRootEventId
          ? { 'm.relates_to': { rel_type: 'm.thread', event_id: options.threadRootEventId } }
          : {}),
      }),
    });
    const sent = (await sendResponse.json()) as { event_id?: string };
    if (!sent.event_id) throw new Error('Matrix file send response did not include event_id');
    return { eventId: sent.event_id };
  }

  async sendAudio(
    roomId: string,
    path: string,
    options: MatrixRelationOptions = {},
  ): Promise<{ eventId: string }> {
    return this.sendFile(roomId, path, {
      ...options,
      msgtype: 'm.audio',
      mimeType: 'audio/wav',
      voice: true,
    });
  }

  async sendOutput(
    roomId: string,
    output: string,
    options: MatrixRelationOptions = {},
  ): Promise<void> {
    const mediaPaths = [...output.matchAll(/^MEDIA:\s*(.+)$/gm)].map((match) => match[1].trim());
    const text = output.replace(/^MEDIA:\s*.+$/gm, '').trim();
    if (text)
      await this.sendText(roomId, text, {
        ...options,
        ...(options.transactionId ? { transactionId: `${options.transactionId}-text` } : {}),
      });
    for (const [index, path] of mediaPaths.entries())
      await this.sendFile(roomId, path, {
        ...options,
        ...(options.transactionId
          ? { transactionId: `${options.transactionId}-media-${index}` }
          : {}),
      });
    if (!text && !mediaPaths.length)
      await this.sendText(roomId, 'NUAAI completed the run without output.', options);
  }

  async start(onMessage: (message: MatrixMessage) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.running) {
      let messages: MatrixMessage[] = [];
      try {
        messages = await this.syncOnce();
        for (const message of messages) {
          if (this.running) await onMessage(message);
        }
        await this.checkpoint();
      } catch (error) {
        for (const message of messages) this.seenEventIds.delete(message.eventId);
        this.pendingSince = undefined;
        if (!this.running) break;
        process.stderr.write(
          `Matrix sync unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, this.config.retryDelayMs ?? 2_000));
      }
    }
  }

  private async checkpoint(): Promise<void> {
    if (!this.pendingSince) return;
    await this.config.onSince?.(this.pendingSince);
    this.since = this.pendingSince;
    this.pendingSince = undefined;
    this.hasSynced = true;
  }

  stop(): void {
    this.running = false;
  }
}
