import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import fg from 'fast-glob';

import { workspaceDirectory } from '../config/index.js';
import { createEvent } from '../core/events.js';
import type { DatabaseStore } from '../memory/db.js';
import { type PluginManifest, pluginManifestSchema } from './manifest.js';

const SUPPORTED_API_MAJOR = 1;
const MAX_PLUGIN_OUTPUT_BYTES = 1_000_000;
const PLUGIN_TIMEOUT_MS = 10_000;
const PLUGIN_WORKER = `
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const entryPath = process.argv[1];
try {
  const loaded = await import(pathToFileURL(entryPath).href);
  const execute = loaded.execute ?? loaded.default;
  if (typeof execute !== 'function') throw new Error('Plugin entry must export execute');
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line);
      const result = await execute(request);
      process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\\n');
    }
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

interface PluginRecord {
  manifest: PluginManifest;
  pluginRoot: string;
  entryPath: string;
}

function majorVersion(value: string): number | undefined {
  const match = value.match(/(?:^|[<>=~^*\s])v?(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function compatibleVersion(version: string, range: string): boolean {
  if (range === '*' || range === '') return true;
  const actual = majorVersion(version);
  const expected = majorVersion(range);
  if (actual === undefined || expected === undefined) return false;
  if (range.startsWith('^') || range.startsWith('~')) return actual === expected;
  if (range.startsWith('>=')) return actual >= expected;
  return version === range || actual === expected;
}

function compatibleApi(value: string): boolean {
  return majorVersion(value) === SUPPORTED_API_MAJOR;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly disabled = new Set<string>();
  private readonly failures = new Map<string, string>();
  private readonly children = new Map<string, Set<ChildProcessWithoutNullStreams>>();

  constructor(
    private readonly root: string,
    private readonly store?: DatabaseStore,
  ) {}

  list(): PluginManifest[] {
    return [...this.plugins.values()]
      .map((record) => record.manifest)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async load(): Promise<PluginManifest[]> {
    this.stopAllChildren();
    this.plugins.clear();
    this.disabled.clear();
    this.failures.clear();
    const root = workspaceDirectory(this.root);
    const persisted = new Map(this.store?.listPlugins().map((plugin) => [plugin.name, plugin]));
    const candidates = new Map<string, PluginRecord>();
    for (const manifestPath of await fg('plugins/*/manifest.json', {
      cwd: root,
      onlyFiles: true,
    })) {
      const pluginRoot = resolve(root, manifestPath, '..');
      try {
        const manifest = pluginManifestSchema.parse(
          JSON.parse(await readFile(resolve(root, manifestPath), 'utf8')),
        );
        if (!manifest.trusted) {
          this.refuse(manifest.name, 'Untrusted plugin refused');
          continue;
        }
        if (!compatibleApi(manifest.apiVersion)) {
          this.refuse(manifest.name, `Unsupported plugin API version ${manifest.apiVersion}`);
          continue;
        }
        const entryPath = resolve(pluginRoot, manifest.entry);
        const relativeEntry = relative(pluginRoot, entryPath);
        if (!relativeEntry || relativeEntry.startsWith('..') || relativeEntry.includes(`..${'/'}`))
          throw new Error('Plugin entry must remain inside the plugin directory');
        const entryStat = await stat(entryPath);
        if (!entryStat.isFile()) throw new Error('Plugin entry must be a file');
        if (candidates.has(manifest.name))
          throw new Error(`Duplicate plugin name ${manifest.name}`);
        candidates.set(manifest.name, { manifest, pluginRoot, entryPath });
      } catch (error) {
        const name = this.manifestNameFromPath(manifestPath);
        this.refuse(name, safeError(error));
      }
    }
    for (const [name, record] of candidates) {
      const missing = Object.entries(record.manifest.dependencies).find(([dependency, range]) => {
        const target = candidates.get(dependency);
        return !target || !compatibleVersion(target.manifest.version, range);
      });
      if (missing) {
        this.refuse(name, `Unsatisfied plugin dependency ${missing[0]} (${missing[1]})`);
        continue;
      }
      this.plugins.set(name, record);
      const saved = persisted.get(name);
      if (saved) {
        record.manifest.config = { ...saved.config };
        if (!saved.enabled) this.disabled.add(name);
      }
      this.store?.upsertPlugin({
        name,
        version: record.manifest.version,
        apiVersion: record.manifest.apiVersion,
        entry: record.manifest.entry,
        enabled: !this.disabled.has(name),
        capabilities: record.manifest.capabilities,
        dependencies: record.manifest.dependencies,
        config: record.manifest.config,
        source: record.pluginRoot,
        lastError: null,
      });
      this.store?.appendEvent(
        createEvent(
          'plugin.loaded',
          {
            name,
            version: record.manifest.version,
            capabilities: record.manifest.capabilities,
          },
          { source: 'plugins' },
        ),
      );
    }
    return this.list();
  }

  async reload(name: string): Promise<PluginManifest[]> {
    if (!this.plugins.has(name)) throw new Error(`Unknown plugin: ${name}`);
    this.stopChildren(name);
    return this.load();
  }

  enable(name: string): void {
    if (!this.plugins.has(name)) throw new Error(`Unknown plugin: ${name}`);
    this.disabled.delete(name);
    this.store?.updatePlugin(name, { enabled: true, lastError: null });
    this.store?.appendEvent(
      createEvent('plugin.loaded', { name, reason: 'enabled' }, { source: 'plugins' }),
    );
  }

  configure(name: string, config: Record<string, unknown>): void {
    const record = this.plugins.get(name);
    if (!record) throw new Error(`Unknown plugin: ${name}`);
    record.manifest.config = { ...config };
    this.store?.updatePlugin(name, { config: record.manifest.config });
    this.store?.appendEvent(
      createEvent('plugin.loaded', { name, reason: 'configured' }, { source: 'plugins' }),
    );
  }

  async execute(name: string, input: unknown): Promise<unknown> {
    const record = this.plugins.get(name);
    if (!record) throw new Error(`Unknown plugin: ${name}`);
    if (this.disabled.has(name)) throw new Error(`Plugin ${name} is disabled`);
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', PLUGIN_WORKER, record.entryPath],
      {
        cwd: record.pluginRoot,
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'production',
          NUAI_PLUGIN_NAME: name,
          NUAI_PLUGIN_CAPABILITIES: record.manifest.capabilities.join(','),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    this.trackChild(name, child);
    try {
      const result = await this.invokeChild(name, child, {
        input,
        config: record.manifest.config,
        capabilities: record.manifest.capabilities,
      });
      this.failures.delete(name);
      this.store?.updatePlugin(name, { lastError: null });
      return result;
    } catch (error) {
      const message = safeError(error);
      this.failures.set(name, message);
      this.store?.updatePlugin(name, { lastError: message });
      this.store?.appendEvent(
        createEvent(
          'plugin.unloaded',
          { name, reason: 'execution_failed', error: message },
          { source: 'plugins' },
        ),
      );
      throw new Error(`Plugin ${name} failed: ${message}`);
    } finally {
      this.untrackChild(name, child);
      if (!child.killed) child.kill('SIGTERM');
    }
  }

  unload(name: string): void {
    if (!this.plugins.delete(name)) throw new Error(`Unknown plugin: ${name}`);
    this.stopChildren(name);
    this.disabled.delete(name);
    this.failures.delete(name);
    this.store?.deletePlugin(name);
    this.store?.appendEvent(createEvent('plugin.unloaded', { name }, { source: 'plugins' }));
  }

  disable(name: string): void {
    if (!this.plugins.has(name)) throw new Error(`Unknown plugin: ${name}`);
    this.disabled.add(name);
    this.stopChildren(name);
    this.store?.updatePlugin(name, { enabled: false });
    this.store?.appendEvent(
      createEvent('plugin.unloaded', { name, reason: 'disabled' }, { source: 'plugins' }),
    );
  }

  health(): Array<{
    name: string;
    loaded: boolean;
    enabled: boolean;
    capabilities: string[];
    error?: string;
  }> {
    const loaded = this.list().map((plugin) => ({
      name: plugin.name,
      loaded: true,
      enabled: !this.disabled.has(plugin.name),
      capabilities: plugin.capabilities,
      ...(this.failures.has(plugin.name) ? { error: this.failures.get(plugin.name) } : {}),
    }));
    const refused = [...this.failures.entries()]
      .filter(([name]) => !this.plugins.has(name))
      .map(([name, error]) => ({ name, loaded: false, enabled: false, capabilities: [], error }));
    return [...loaded, ...refused].sort((left, right) => left.name.localeCompare(right.name));
  }

  private async invokeChild(
    name: string,
    child: ChildProcessWithoutNullStreams,
    request: Record<string, unknown>,
  ): Promise<unknown> {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_PLUGIN_OUTPUT_BYTES) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
    const timer = setTimeout(() => child.kill('SIGKILL'), PLUGIN_TIMEOUT_MS);
    try {
      const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
      if (Buffer.byteLength(stdout) > MAX_PLUGIN_OUTPUT_BYTES)
        throw new Error('Plugin output exceeded the 1 MB limit');
      if (code !== 0)
        throw new Error(stderr || `Plugin process exited with ${signal ?? code ?? 'unknown'}`);
      const line = stdout.trim().split('\n').filter(Boolean).at(-1);
      if (!line) throw new Error('Plugin returned no result');
      const response = JSON.parse(line) as { ok?: boolean; result?: unknown; error?: string };
      if (!response.ok) throw new Error(response.error || 'Plugin returned an error');
      return response.result;
    } finally {
      clearTimeout(timer);
      if (!child.killed) child.kill('SIGTERM');
      this.untrackChild(name, child);
    }
  }

  private manifestNameFromPath(path: string): string {
    return path.split('/').at(-2) ?? 'unknown-plugin';
  }

  private refuse(name: string, error: string): void {
    this.failures.set(name, error);
    this.store?.appendEvent(createEvent('plugin.unloaded', { name, error }, { source: 'plugins' }));
  }

  private trackChild(name: string, child: ChildProcessWithoutNullStreams): void {
    const children = this.children.get(name) ?? new Set<ChildProcessWithoutNullStreams>();
    children.add(child);
    this.children.set(name, children);
  }

  private untrackChild(name: string, child: ChildProcessWithoutNullStreams): void {
    const children = this.children.get(name);
    children?.delete(child);
    if (children && children.size === 0) this.children.delete(name);
  }

  private stopChildren(name: string): void {
    for (const child of this.children.get(name) ?? []) child.kill('SIGTERM');
    this.children.delete(name);
  }

  private stopAllChildren(): void {
    for (const name of this.children.keys()) this.stopChildren(name);
  }
}
