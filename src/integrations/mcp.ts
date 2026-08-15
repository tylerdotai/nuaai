import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { type Interface, createInterface } from 'node:readline';

import type { RuntimeConfig } from '../config/index.js';
import type { PermissionContext, PermissionLevel } from '../security/permissions.js';

export interface McpToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permission: PermissionLevel;
  server: string;
  remoteName: string;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

type McpServerConfig = RuntimeConfig['mcp']['servers'][string];

function namespace(server: string, tool: string): string {
  return `mcp.${server}.${tool}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

class McpServerClient {
  private process?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private tools: McpToolSchema[] = [];

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
  ) {}

  async start(): Promise<void> {
    const child = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env, ...this.config.env },
    });
    this.process = child;
    child.on('error', (error) => this.failPending(error));
    child.on('exit', (code, signal) => {
      if (code !== 0 || signal) this.failPending(new Error(`MCP server ${this.name} exited`));
    });
    child.stderr.on('data', () => undefined);
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    await this.request(child, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'nuaai', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
    const response = (await this.request(child, 'tools/list', {})) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    this.tools = (response.tools ?? []).flatMap((tool) =>
      tool.name
        ? [
            {
              name: namespace(this.name, tool.name),
              remoteName: tool.name,
              server: this.name,
              permission: this.config.permission,
              description: `[MCP ${this.name}] ${tool.description ?? tool.name}`,
              parameters: tool.inputSchema ?? { type: 'object', properties: {} },
            },
          ]
        : [],
    );
  }

  listTools(): McpToolSchema[] {
    return this.tools;
  }

  async call(tool: McpToolSchema, argumentsValue: Record<string, unknown>): Promise<unknown> {
    const result = (await this.request(
      this.process as ChildProcessWithoutNullStreams,
      'tools/call',
      {
        name: tool.remoteName,
        arguments: argumentsValue,
      },
    )) as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (result.isError) throw new Error(`MCP ${this.name}.${tool.remoteName} returned an error`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = (result.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n');
    return text || result;
  }

  stop(): void {
    this.lines?.close();
    this.process?.kill('SIGTERM');
    this.failPending(new Error(`MCP server ${this.name} stopped`));
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.process?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private request(
    process: ChildProcessWithoutNullStreams,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${this.name}.${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      process.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
        (error) => {
          if (error) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(error);
          }
        },
      );
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let value: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      value = JSON.parse(line) as typeof value;
    } catch {
      return;
    }
    if (typeof value.id !== 'number') return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    if (value.error) pending.reject(new Error(value.error.message ?? 'MCP request failed'));
    else pending.resolve(value.result);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export class McpManager {
  private readonly servers = new Map<string, McpServerClient>();
  private readonly failures = new Map<string, string>();

  constructor(private readonly config: RuntimeConfig['mcp']) {}

  async start(): Promise<void> {
    if (!this.config.enabled) return;
    const configuredServers: Record<string, McpServerConfig> = { ...this.config.servers };
    if (this.config.computer.enabled && !configuredServers.computer) {
      configuredServers.computer = {
        command: this.config.computer.command,
        args: this.config.computer.args,
        env: {},
        permission: 'execute',
      };
    }
    for (const [name, serverConfig] of Object.entries(configuredServers)) {
      const server = new McpServerClient(name, serverConfig);
      try {
        await server.start();
        this.servers.set(name, server);
      } catch (error) {
        this.failures.set(name, error instanceof Error ? error.message : String(error));
        server.stop();
      }
    }
  }

  schemas(
    permissions: PermissionContext,
  ): Array<Omit<McpToolSchema, 'remoteName' | 'server' | 'permission'>> {
    return [...this.servers.values()]
      .flatMap((server) => server.listTools())
      .filter((tool) => permissions.approved.has(tool.permission))
      .map(
        ({ remoteName: _remoteName, server: _server, permission: _permission, ...tool }) => tool,
      );
  }

  async execute(
    name: string,
    argumentsValue: Record<string, unknown>,
    permissions: PermissionContext,
  ): Promise<unknown> {
    const allTools = [...this.servers.values()].flatMap((server) => server.listTools());
    const tool = allTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    if (!permissions.approved.has(tool.permission))
      throw new Error(`Permission required: ${tool.permission}`);
    const server = this.servers.get(tool.server) as McpServerClient;
    return server.call(tool, argumentsValue);
  }

  status(): { servers: string[]; failures: Record<string, string> } {
    return { servers: [...this.servers.keys()], failures: Object.fromEntries(this.failures) };
  }

  stop(): void {
    for (const server of this.servers.values()) server.stop();
    this.servers.clear();
  }
}
