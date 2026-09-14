import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import { sanitizedSubprocessEnvironment } from '../security/environment.js';
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
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => `[${message.role}]\n${message.content}`)
    .join('\n\n');
}

function codexJsonOutput(stdout: string): string {
  let output = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
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
    if (text && text !== output)
      output += text.startsWith(output) ? text.slice(output.length) : text;
  }
  return output;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
    const outputPath = join(tmpdir(), `nuaai-codex-${randomUUID()}.txt`);
    const args = [
      '--ask-for-approval',
      'never',
      'exec',
      '--output-last-message',
      outputPath,
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '--cd',
      this.workspaceRoot,
      '--skip-git-repo-check',
    ];
    const model = request.model || this.model;
    if (model) args.push('--model', model);
    args.push('-');
    const prompt = promptFromMessages(request.messages);
    const subprocess = execa(this.executable, args, {
      reject: false,
      timeout: this.timeoutMs,
      cancelSignal: request.signal,
      input: prompt,
      windowsHide: true,
      env: sanitizedSubprocessEnvironment(),
      extendEnv: false,
    });
    let settled = false;
    let result: Awaited<typeof subprocess> | undefined;
    let processError: unknown;
    const settledProcess = subprocess
      .then((value) => {
        result = value;
      })
      .catch((error: unknown) => {
        processError = error;
      })
      .finally(() => {
        settled = true;
      });
    let output = '';
    try {
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        if (request.signal?.aborted)
          throw request.signal.reason instanceof Error
            ? request.signal.reason
            : new Error('Codex exec aborted');
        try {
          output = await readFile(outputPath, 'utf8');
          if (output.trim()) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (settled) break;
        await delay(100);
      }
      if (!output.trim()) {
        await settledProcess;
        if (processError) throw processError;
        if (result?.exitCode !== 0)
          throw new Error(
            `Codex exec failed (${result?.exitCode ?? 'unknown'}): ${result?.stderr || result?.stdout || ''}`,
          );
        output = codexJsonOutput(result?.stdout ?? '');
      }
      if (!output.trim()) throw new Error('Codex exec returned no final message');
      yield { type: 'delta', text: output };
      yield { type: 'done', text: output };
    } finally {
      subprocess.kill('SIGTERM');
      await Promise.race([settledProcess, delay(1_000)]);
      await unlink(outputPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async embed(): Promise<number[]> {
    throw new Error('Codex does not provide embeddings; configure Ollama for memory embeddings');
  }

  async health(): Promise<ProviderHealth> {
    try {
      const result = await execa(this.executable, ['--version'], {
        reject: false,
        timeout: 10_000,
        env: sanitizedSubprocessEnvironment(),
        extendEnv: false,
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
