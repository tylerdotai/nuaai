import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

export interface MatrixConfig {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  pollTimeoutMs?: number;
  since?: string;
  onSince?: (since: string) => void;
  downloadDirectory?: string;
  workspaceRoot?: string;
  maxAttachmentBytes?: number;
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
  attachments?: MatrixAttachment[];
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

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

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
        content?: {
          msgtype?: string;
          body?: string;
          url?: string;
          filename?: string;
          info?: { mimetype?: string; size?: number };
          file?: { url?: string; name?: string; mimetype?: string; size?: number };
        };
      };
      const content = item.content;
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
        (content.msgtype !== 'm.text' && !attachments.length) ||
        !item.event_id ||
        !item.sender ||
        (!content.body?.trim() && !attachments.length)
      )
        continue;
      messages.push({
        roomId,
        eventId: item.event_id,
        sender: item.sender,
        body:
          content.body?.trim() ||
          attachments.map((attachment) => `[Attachment: ${attachment.name}]`).join('\n'),
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

export class MatrixBridge {
  private since: string | undefined;
  private running = false;

  constructor(
    private readonly config: MatrixConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.since = config.since;
  }

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
    if (value.next_batch) {
      this.since = value.next_batch;
      this.config.onSince?.(value.next_batch);
    }
    for (const roomId of extractMatrixInvites(value)) await this.joinRoom(roomId);
    const messages = extractMatrixMessages(value, this.config.userId);
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
    const response = await this.fetchImpl(
      matrixMediaUrl(this.config.homeserverUrl, attachment.mxcUrl),
      {
        headers: { authorization: `Bearer ${this.config.accessToken}` },
      },
    );
    assertOk(response);
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

  async sendReceipt(roomId: string, eventId: string): Promise<void> {
    const url = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
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

  async setTyping(roomId: string, typing: boolean): Promise<void> {
    const url = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.config.userId)}`,
    );
    const response = await this.fetchImpl(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ typing, timeout: typing ? 30_000 : 0 }),
    });
    assertOk(response);
  }

  async sendText(roomId: string, body: string): Promise<{ eventId: string }> {
    if (!body.trim()) throw new Error('Matrix message body is required');
    const formatted = formatMatrixBody(body);
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
      body: JSON.stringify({
        msgtype: 'm.text',
        body,
        format: formatted.format,
        formatted_body: formatted.formattedBody,
      }),
    });
    assertOk(response);
    const value = (await response.json()) as { event_id?: string };
    if (!value.event_id) throw new Error('Matrix send response did not include event_id');
    return { eventId: value.event_id };
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
    const response = await this.fetchImpl(url, {
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
    assertOk(response);
  }

  async sendFile(
    roomId: string,
    path: string,
    options: { msgtype?: 'm.file' | 'm.audio'; mimeType?: string } = {},
  ): Promise<{ eventId: string }> {
    const root = this.config.workspaceRoot ? resolve(this.config.workspaceRoot) : undefined;
    const target = resolve(path);
    if (root && target !== root && !target.startsWith(`${root}${sep}`))
      throw new Error('Outbound Matrix files must be inside the NUAAI workspace');
    const file = await stat(target);
    if (!file.isFile()) throw new Error(`Not a regular file: ${path}`);
    const bytes = await readFile(target);
    const max = this.config.maxAttachmentBytes ?? 50_000_000;
    if (bytes.byteLength > max)
      throw new Error('Outbound Matrix attachment exceeds the configured size limit');
    const upload = apiUrl(this.config.homeserverUrl, '/_matrix/media/v3/upload');
    upload.searchParams.set('filename', basename(target));
    const uploadResponse = await this.fetchImpl(upload, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/octet-stream',
      },
      body: bytes,
    });
    assertOk(uploadResponse);
    const uploaded = (await uploadResponse.json()) as { content_uri?: string };
    if (!uploaded.content_uri) throw new Error('Matrix media upload did not return content_uri');
    const sendUrl = apiUrl(
      this.config.homeserverUrl,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${randomUUID()}`,
    );
    const sendResponse = await this.fetchImpl(sendUrl, {
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
      }),
    });
    assertOk(sendResponse);
    const sent = (await sendResponse.json()) as { event_id?: string };
    if (!sent.event_id) throw new Error('Matrix file send response did not include event_id');
    return { eventId: sent.event_id };
  }

  async sendAudio(roomId: string, path: string): Promise<{ eventId: string }> {
    return this.sendFile(roomId, path, { msgtype: 'm.audio', mimeType: 'audio/wav' });
  }

  async sendOutput(roomId: string, output: string): Promise<void> {
    const mediaPaths = [...output.matchAll(/^MEDIA:\s*(.+)$/gm)].map((match) => match[1].trim());
    const text = output.replace(/^MEDIA:\s*.+$/gm, '').trim();
    if (text) await this.sendText(roomId, text);
    for (const path of mediaPaths) await this.sendFile(roomId, path);
    if (!text && !mediaPaths.length)
      await this.sendText(roomId, 'NUAAI completed the run without output.');
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
