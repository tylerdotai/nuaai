import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const maxHelperOutputBytes = 2_000_000;
const maxHelperErrorBytes = 20_000;

export interface LocalAudioBridgeConfig {
  pythonCommand: string;
  scriptPath: string;
  allowedRoot: string;
  outputDirectory: string;
  model: string;
  device: string;
  computeType: string;
  voice: string;
  kokoroModelPath: string;
  kokoroVoicesPath: string;
  timeoutMs: number;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  segments: unknown[];
}

export interface SpeechResult {
  path: string;
  mimeType: 'audio/wav';
}

export interface AudioFeatureState {
  voiceEnabled: boolean;
  ttsEnabled: boolean;
}

export function handleAudioCommand(
  name: string,
  args: string[],
  state: AudioFeatureState,
): string | undefined {
  if (name !== 'voice' && name !== 'tts') return undefined;
  const key = name === 'voice' ? 'voiceEnabled' : 'ttsEnabled';
  const mode = args[0]?.toLowerCase();
  if (!mode || mode === 'status') return `${name} is ${state[key] ? 'on' : 'off'}.`;
  if (mode === 'on' || mode === 'enable') {
    state[key] = true;
    return `${name} enabled.`;
  }
  if (mode === 'off' || mode === 'disable') {
    state[key] = false;
    return `${name} disabled.`;
  }
  return `Usage: /${name} on|off|status`;
}

function withinRoot(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  );
}

export class LocalAudioBridge {
  private readonly config: LocalAudioBridgeConfig;
  private readonly allowedRoot: string;
  private readonly outputDirectory: string;

  constructor(config: LocalAudioBridgeConfig) {
    this.config = config;
    this.allowedRoot = resolve(config.allowedRoot);
    this.outputDirectory = resolve(config.outputDirectory);
    if (!withinRoot(this.allowedRoot, this.outputDirectory))
      throw new Error('Audio output directory escapes the allowed root');
  }

  async transcribe(inputPath: string): Promise<TranscriptionResult> {
    const input = await this.assertInput(inputPath);
    const result = await this.runHelper([
      'transcribe',
      '--input',
      input,
      '--model',
      this.config.model,
      '--device',
      this.config.device,
      '--compute-type',
      this.config.computeType,
    ]);
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    return {
      text,
      ...(typeof result.language === 'string' ? { language: result.language } : {}),
      segments: Array.isArray(result.segments) ? result.segments : [],
    };
  }

  async synthesize(text: string): Promise<SpeechResult> {
    const value = text.trim();
    if (!value) throw new Error('Cannot synthesize empty text');
    if (value.length > 20_000) throw new Error('Speech input exceeds the configured limit');
    await mkdir(this.outputDirectory, { recursive: true });
    const outputPath = resolve(this.outputDirectory, `nuaai-${randomUUID()}.wav`);
    if (!withinRoot(this.allowedRoot, outputPath))
      throw new Error('Audio output path escapes the allowed root');
    await this.runHelper([
      'synthesize',
      '--text',
      value,
      '--output',
      outputPath,
      '--voice',
      this.config.voice,
      '--kokoro-model',
      this.config.kokoroModelPath,
      '--kokoro-voices',
      this.config.kokoroVoicesPath,
    ]);
    const output = await stat(outputPath).catch(() => undefined);
    if (!output?.isFile() || output.size === 0)
      throw new Error('Audio helper did not produce a WAV file');
    return { path: outputPath, mimeType: 'audio/wav' };
  }

  private async assertInput(inputPath: string): Promise<string> {
    const target = resolve(inputPath);
    if (!withinRoot(this.allowedRoot, target))
      throw new Error('Transcription input escapes the allowed root');
    const input = await stat(target).catch(() => undefined);
    if (!input?.isFile())
      throw new Error(`Transcription input is not a regular file: ${inputPath}`);
    return target;
  }

  private runHelper(args: string[]): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.config.pythonCommand, [this.config.scriptPath, ...args], {
        cwd: this.allowedRoot,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`Audio helper timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (Buffer.byteLength(stdout) > maxHelperOutputBytes) {
          child.kill('SIGKILL');
          finish(() => reject(new Error('Audio helper output exceeded the configured limit')));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(stderr) <= maxHelperErrorBytes) stderr += chunk.toString();
      });
      child.on('error', (error) => finish(() => reject(error)));
      child.on('close', (code, signal) =>
        finish(() => {
          if (code !== 0) {
            const detail = stderr.trim() || (signal ? `signal ${signal}` : `exit ${code}`);
            reject(new Error(`Audio helper failed: ${detail}`));
            return;
          }
          try {
            const value = JSON.parse(stdout.trim()) as unknown;
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw new Error('Audio helper returned a non-object result');
            resolvePromise(value as Record<string, unknown>);
          } catch (error) {
            reject(
              new Error(
                `Audio helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        }),
      );
    });
  }
}

export class LocalTranscriber {
  private readonly bridge: LocalAudioBridge;

  constructor(config: LocalAudioBridgeConfig) {
    this.bridge = new LocalAudioBridge(config);
  }

  transcribe(inputPath: string): Promise<TranscriptionResult> {
    return this.bridge.transcribe(inputPath);
  }
}
