import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { type Interface, createInterface } from 'node:readline';

import type { RuntimeConfig } from '../config/index.js';
import { sanitizedSubprocessEnvironment } from '../security/environment.js';
import type { PermissionContext, PermissionLevel } from '../security/permissions.js';
import { getVersion } from '../version.js';

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
      env: sanitizedSubprocessEnvironment(this.config.env),
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
      clientInfo: { name: 'nuaai', version: getVersion() },
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

  async call(
    tool: McpToolSchema,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = (await this.request(
      this.process as ChildProcessWithoutNullStreams,
      'tools/call',
      {
        name: tool.remoteName,
        arguments: argumentsValue,
      },
      signal,
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const rejectReason = (): Error =>
        signal?.reason instanceof Error ? signal.reason : new Error('MCP request cancelled');
      if (signal?.aborted) {
        reject(rejectReason());
        return;
      }
      const cleanup = (): void => signal?.removeEventListener('abort', abort);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`MCP request timed out: ${this.name}.${method}`));
      }, 30_000);
      const abort = (): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        cleanup();
        this.notify('notifications/cancelled', {
          requestId: id,
          reason: rejectReason().message,
        });
        reject(rejectReason());
      };
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener('abort', abort, { once: true });
      process.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
        (error) => {
          if (error) {
            this.pending.delete(id);
            clearTimeout(timer);
            cleanup();
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    const allTools = [...this.servers.values()].flatMap((server) => server.listTools());
    const tool = allTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    if (!permissions.approved.has(tool.permission))
      throw new Error(`Permission required: ${tool.permission}`);
    const server = this.servers.get(tool.server) as McpServerClient;
    return server.call(tool, argumentsValue, signal);
  }

  status(): {
    servers: string[];
    failures: Record<string, string>;
    tools: Array<{
      name: string;
      description: string;
      permission: PermissionLevel;
      server: string;
    }>;
  } {
    return {
      servers: [...this.servers.keys()],
      failures: Object.fromEntries(this.failures),
      tools: [...this.servers.values()].flatMap((server) =>
        server.listTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          permission: tool.permission,
          server: tool.server,
        })),
      ),
    };
  }

  discover(
    permissions: PermissionContext,
  ): Array<Omit<McpToolSchema, 'remoteName' | 'server' | 'permission'>> {
    return this.schemas(permissions);
  }

  async executeComputer(
    action: string,
    args: Record<string, unknown>,
    permissions: PermissionContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const actionName = action.trim().toLowerCase();
    const readActions = new Set(['capture', 'list_apps', 'list_windows']);
    const requiredPermission: PermissionLevel = readActions.has(actionName) ? 'read' : 'execute';
    if (!permissions.approved.has(requiredPermission))
      throw new Error(`Permission required: ${requiredPermission}`);
    const tools = [...this.servers.values()]
      .flatMap((server) => server.listTools())
      .filter((tool) => tool.server === 'computer');
    if (!tools.length) throw new Error('Computer-use MCP server is unavailable');
    const byRemoteName = new Map(tools.map((tool) => [tool.remoteName, tool]));
    const coordinate = Array.isArray(args.coordinate) ? args.coordinate : undefined;
    const forwarded: Record<string, unknown> = { ...args };
    if (coordinate?.length === 2) {
      forwarded.x = coordinate[0];
      forwarded.y = coordinate[1];
    }
    if (args.element !== undefined) forwarded.element_index = args.element;
    forwarded.action = undefined;
    forwarded.coordinate = undefined;
    forwarded.element = undefined;
    let remoteName: string;
    switch (actionName) {
      case 'capture':
        remoteName =
          args.app &&
          ['screen', 'desktop', 'fullscreen', 'all'].includes(String(args.app).toLowerCase())
            ? 'get_desktop_state'
            : 'get_window_state';
        if (remoteName === 'get_window_state') {
          forwarded.include_screenshot = true;
          if (args.max_elements !== undefined) forwarded.max_elements = args.max_elements;
        }
        break;
      case 'list_apps':
      case 'list_windows':
      case 'click':
      case 'double_click':
      case 'right_click':
      case 'middle_click':
      case 'drag':
      case 'scroll':
      case 'type':
      case 'set_value':
        remoteName =
          actionName === 'type'
            ? 'type_text'
            : actionName === 'set_value'
              ? 'set_value'
              : actionName;
        break;
      case 'key': {
        const parts = String(args.keys ?? '')
          .split(/[+\\-]/)
          .map((part) => part.trim())
          .filter(Boolean);
        if (!parts.length) throw new Error('key requires keys');
        if (parts.length === 1) {
          remoteName = 'press_key';
          forwarded.key = parts[0];
          forwarded.keys = undefined;
        } else {
          remoteName = 'hotkey';
          forwarded.keys = parts;
        }
        break;
      }
      default:
        throw new Error(`Unsupported computer-use action: ${actionName}`);
    }
    if (actionName === 'double_click') {
      remoteName = byRemoteName.has('double_click') ? 'double_click' : 'click';
      if (remoteName === 'click') forwarded.count = 2;
    }
    if (actionName === 'right_click' || actionName === 'middle_click') {
      if (!byRemoteName.has(remoteName)) {
        remoteName = 'click';
        forwarded.button = actionName === 'right_click' ? 'right' : 'middle';
      }
    }
    if (actionName === 'type') forwarded.text = args.text ?? '';
    if (actionName === 'set_value') forwarded.value = args.value ?? '';
    if (actionName === 'drag') {
      const from = Array.isArray(args.from_coordinate) ? args.from_coordinate : [];
      const to = Array.isArray(args.to_coordinate) ? args.to_coordinate : [];
      if (from.length === 2) {
        forwarded.from_x = from[0];
        forwarded.from_y = from[1];
      }
      if (to.length === 2) {
        forwarded.to_x = to[0];
        forwarded.to_y = to[1];
      }
      forwarded.from_coordinate = undefined;
      forwarded.to_coordinate = undefined;
    }
    if (
      actionName === 'type' &&
      /(curl|wget)\s+[^|]*\|\s*(bash|sh)|\bsudo\s+rm\s+-[rf]|\brm\s+-rf\s+\u002f\s*$/i.test(
        String(forwarded.text),
      )
    )
      throw new Error('Blocked dangerous type payload');
    if (actionName === 'key') {
      const normalized = String(args.keys ?? '')
        .toLowerCase()
        .replace(/[-\s]/g, '+');
      if (
        ['win+l', 'ctrl+alt+delete', 'ctrl+alt+del', 'alt+f4', 'cmd+shift+q'].includes(normalized)
      )
        throw new Error('Blocked destructive key combination');
    }
    const tool = byRemoteName.get(remoteName);
    if (!tool) throw new Error(`Computer-use MCP tool unavailable: ${remoteName}`);
    const server = this.servers.get(tool.server);
    if (!server) throw new Error(`Computer-use MCP server unavailable: ${tool.server}`);
    return server.call(tool, forwarded, signal);
  }
  stop(): void {
    for (const server of this.servers.values()) server.stop();
    this.servers.clear();
  }
}
