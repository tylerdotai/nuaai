import { execa } from 'execa';

import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderRequest,
  ProviderStreamEvent,
} from './types.js';

interface CodexConfig {
  executable?: string;
  model: string;
  workspaceRoot: string;
  timeoutMs?: number;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'message']) {
    const candidate = record[key];
    if (typeof candidate === 'string') return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = extractText(candidate);
      if (nested) return nested;
    }
  }
  return '';
}

function promptFromMessages(messages: ProviderRequest['messages']): string {
  return messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n');
}

export class CodexProvider implements ProviderAdapter {
  readonly name = 'codex';
  readonly model: string;
  private readonly executable: string;
  private readonly workspaceRoot: string;
  private readonly timeoutMs: number;

  constructor(config: CodexConfig) {
    this.executable = config.executable ?? 'codex';
    this.model = config.model;
    this.workspaceRoot = config.workspaceRoot;
    this.timeoutMs = config.timeoutMs ?? 300_000;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--cd',
      this.workspaceRoot,
      '--skip-git-repo-check',
    ];
    const model = request.model || this.model;
    if (model) args.push('--model', model);
    args.push(promptFromMessages(request.messages));
    const resultPromise = execa(this.executable, args, {
      reject: false,
      timeout: this.timeoutMs,
      cancelSignal: request.signal,
      input: '',
      windowsHide: true,
    });
    const result = await resultPromise;
    if (result.exitCode !== 0)
      throw new Error(
        `Codex exec failed (${result.exitCode ?? 'unknown'}): ${result.stderr || result.stdout}`,
      );
    let output = '';
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        value = line;
      }
      const record =
        value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
      const item = record?.item;
      if (
        record?.type === 'error' ||
        record?.type === 'item.error' ||
        (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'error')
      )
        continue;
      const text = extractText(record?.item ?? record?.message ?? record);
      if (text && text !== output) {
        const delta = text.startsWith(output) ? text.slice(output.length) : text;
        output += delta;
        if (delta) yield { type: 'delta', text: delta };
      }
    }
    if (!output && result.stdout.trim()) {
      output = result.stdout.trim();
      yield { type: 'delta', text: output };
    }
    yield { type: 'done', text: output };
  }

  async embed(): Promise<number[]> {
    throw new Error('Codex does not provide embeddings; configure Ollama for memory embeddings');
  }

  async health(): Promise<ProviderHealth> {
    try {
      const result = await execa(this.executable, ['--version'], {
        reject: false,
        timeout: 10_000,
      });
      return result.exitCode === 0
        ? { name: this.name, available: true, detail: result.stdout.trim() }
        : { name: this.name, available: false, detail: result.stderr || result.stdout };
    } catch (error) {
      return {
        name: this.name,
        available: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
