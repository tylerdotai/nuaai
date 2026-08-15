import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { Scheduler } from '../core/scheduler.js';
import type { ExternalAgentDispatcher } from '../integrations/agents.js';
import type { McpManager } from '../integrations/mcp.js';
import type { MediaProcessor } from '../integrations/media.js';
import type { SearchStack } from '../integrations/search.js';
import type { DatabaseStore } from '../memory/db.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { type PermissionContext, assertPermission } from '../security/permissions.js';
import {
  inspectWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  runWorkspaceCommand,
  searchWorkspace,
  writeWorkspaceFile,
} from '../workspace/fs.js';

export interface ToolContext {
  root: string;
  permissions: PermissionContext;
  timeoutMs?: number;
}
export interface ToolServices {
  store?: DatabaseStore;
  scheduler?: Scheduler;
  providers?: ProviderRegistry;
  mcp?: McpManager;
  media?: MediaProcessor;
  agents?: ExternalAgentDispatcher;
}
export interface ToolDefinition {
  name: string;
  description: string;
  permission: 'read' | 'write' | 'execute';
  parameters: Record<string, unknown>;
  input: z.ZodType<unknown>;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}

const empty = z.object({});

function assertNetwork(context: ToolContext): void {
  if (!context.permissions.capabilities.network) throw new Error('Network capability required');
}

function lexicalMemorySearch(
  rows: ReturnType<DatabaseStore['searchMemoryRows']>,
  query: string,
  limit: number,
): Array<Record<string, unknown>> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .map((memory) => {
      const haystack = memory.content.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { ...memory, embedding: undefined, score };
    })
    .filter((memory) => memory.score > 0)
    .sort((left, right) => right.score - left.score || right.createdAt - left.createdAt)
    .slice(0, limit)
    .map(({ embedding: _embedding, ...memory }) => memory);
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  constructor(
    root: string,
    searchStack?: SearchStack,
    options: { browserEnabled?: boolean } = {},
    services: ToolServices = {},
  ) {
    this.register({
      name: 'workspace.list',
      description: 'List non-protected files in the NUAAI workspace',
      permission: 'read',
      parameters: { type: 'object', properties: {} },
      input: empty,
      execute: async (_input, context) => listWorkspaceFiles(context.root),
    });
    this.register({
      name: 'workspace.read',
      description: 'Read a text file in the NUAAI workspace',
      permission: 'read',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      input: z.object({ path: z.string().min(1) }),
      execute: async (input, context) =>
        readWorkspaceFile(context.root, (input as { path: string }).path),
    });
    this.register({
      name: 'workspace.inspect',
      description:
        'Inspect any non-protected workspace file type and return metadata plus a bounded text preview when the format is text-readable',
      permission: 'read',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      input: z.object({ path: z.string().min(1) }),
      execute: async (input, context) =>
        inspectWorkspaceFile(context.root, (input as { path: string }).path),
    });
    this.register({
      name: 'workspace.write',
      description: 'Write a text file in the NUAAI workspace',
      permission: 'write',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      input: z.object({ path: z.string().min(1), content: z.string() }),
      execute: async (input, context) => {
        const value = input as { path: string; content: string };
        await writeWorkspaceFile(context.root, value.path, value.content);
        return { written: value.path };
      },
    });
    this.register({
      name: 'workspace.search',
      description: 'Search text in workspace files',
      permission: 'read',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      input: z.object({ query: z.string().min(1) }),
      execute: async (input, context) =>
        searchWorkspace(context.root, (input as { query: string }).query),
    });
    this.register({
      name: 'workspace.command',
      description:
        'Run one explicitly allowlisted workspace command (cat, date, df, echo, file, free, hostname, head, lscpu, ls, lsblk, lspci, lsusb, printf, ps, pwd, stat, tail, uname, uptime, wc, which, whoami, node, npm, npx, git, ollama, codex, python, or python3). Put arguments in args. Protected runtime files remain inaccessible, inline Python/Node execution is rejected, and shell operators such as &&, ;, |, and redirects are rejected; issue separate tool calls instead of chaining commands.',
      permission: 'execute',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
        },
        required: ['command'],
      },
      input: z.object({ command: z.string().min(1), args: z.array(z.string()).default([]) }),
      execute: async (input, context) => {
        const value = input as { command: string; args: string[] };
        return runWorkspaceCommand(value.command, value.args, context.root, {
          timeoutMs: context.timeoutMs,
        });
      },
    });
    if (searchStack) {
      this.register({
        name: 'web.search',
        description: 'Search the web through local SearXNG with DuckDuckGo fallback',
        permission: 'read',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 25 },
          },
          required: ['query'],
        },
        input: z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(25).default(10),
        }),
        execute: async (input, context) => {
          assertNetwork(context);
          const value = input as { query: string; limit: number };
          return searchStack.search(value.query, value.limit);
        },
      });
      this.register({
        name: 'web.fetch',
        description:
          'Extract a web page through local Crawl4AI, Playwright, and FlareSolverr fallbacks',
        permission: 'read',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', format: 'uri' } },
          required: ['url'],
        },
        input: z.object({ url: z.string().url() }),
        execute: async (input, context) => {
          assertNetwork(context);
          return searchStack.fetch((input as { url: string }).url);
        },
      });
      if (options.browserEnabled ?? true)
        this.register({
          name: 'browser.open',
          description: 'Open a web page with headless Playwright browser automation',
          permission: 'read',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string', format: 'uri' } },
            required: ['url'],
          },
          input: z.object({ url: z.string().url() }),
          execute: async (input, context) => {
            assertNetwork(context);
            return searchStack.open((input as { url: string }).url);
          },
        });
    }
    if (services.store) {
      const store = services.store;
      this.register({
        name: 'memory.store',
        description:
          'Persist a durable memory with optional Ollama embedding and redacted metadata',
        permission: 'write',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', minLength: 1, maxLength: 50_000 },
            metadata: { type: 'object' },
          },
          required: ['content'],
        },
        input: z.object({
          content: z.string().trim().min(1).max(50_000),
          metadata: z.record(z.unknown()).default({}),
        }),
        execute: async (input) => {
          const value = input as { content: string; metadata: Record<string, unknown> };
          let embedding: number[] | null = null;
          let warning: string | undefined;
          try {
            embedding = services.providers
              ? await services.providers.get('ollama').embed(value.content)
              : null;
          } catch (error) {
            warning = `Embedding unavailable; memory stored lexically: ${error instanceof Error ? error.message : String(error)}`;
          }
          const id = randomUUID();
          store.storeMemory(id, value.content, embedding, value.metadata);
          return {
            id,
            stored: true,
            hasEmbedding: Boolean(embedding),
            ...(warning ? { warning } : {}),
          };
        },
      });
      this.register({
        name: 'memory.search',
        description:
          'Search durable memories semantically when Ollama embeddings are available, with lexical fallback',
        permission: 'read',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 25 },
          },
          required: ['query'],
        },
        input: z.object({
          query: z.string().trim().min(1).max(10_000),
          limit: z.number().int().min(1).max(25).default(8),
        }),
        execute: async (input) => {
          const value = input as { query: string; limit: number };
          try {
            if (services.providers) {
              const embedding = await services.providers.get('ollama').embed(value.query);
              const semantic = store.searchMemory(embedding, value.limit);
              if (semantic.length) return { mode: 'semantic', results: semantic };
            }
          } catch (error) {
            return {
              mode: 'lexical',
              results: lexicalMemorySearch(store.searchMemoryRows(), value.query, value.limit),
              warning: `Semantic search unavailable: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          return {
            mode: 'lexical',
            results: lexicalMemorySearch(store.searchMemoryRows(), value.query, value.limit),
          };
        },
      });
      this.register({
        name: 'memory.forget',
        description: 'Permanently remove one durable memory record by id',
        permission: 'write',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
        },
        input: z.object({ id: z.string().trim().min(1) }),
        execute: async (input) => {
          const id = (input as { id: string }).id;
          return { id, deleted: store.deleteMemory(id) };
        },
      });
    }
    if (services.scheduler) {
      const scheduler = services.scheduler;
      this.register({
        name: 'schedule.create',
        description: 'Create a durable scheduled agent run',
        permission: 'write',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['once', 'interval', 'cron', 'manual', 'startup'] },
            expression: { type: 'string' },
            agentInput: { type: 'string' },
            enabled: { type: 'boolean' },
            policy: { type: 'object' },
          },
          required: ['name', 'type', 'expression', 'agentInput'],
        },
        input: z.object({
          name: z.string().trim().min(1).max(200),
          type: z.enum(['once', 'interval', 'cron', 'manual', 'startup']),
          expression: z.string().max(200),
          agentInput: z.string().trim().min(1).max(50_000),
          enabled: z.boolean().optional(),
          policy: z.record(z.unknown()).optional(),
        }),
        execute: async (input) => scheduler.create(input as Parameters<Scheduler['create']>[0]),
      });
      this.register({
        name: 'schedule.list',
        description: 'List durable schedules and their next run state',
        permission: 'read',
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => ({ schedules: scheduler.list() }),
      });
      this.register({
        name: 'schedule.update',
        description: 'Update a durable schedule',
        permission: 'write',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        input: z.object({
          id: z.string().min(1),
          name: z.string().trim().min(1).max(200).optional(),
          type: z.enum(['once', 'interval', 'cron', 'manual', 'startup']).optional(),
          expression: z.string().max(200).optional(),
          agentInput: z.string().trim().min(1).max(50_000).optional(),
          enabled: z.boolean().optional(),
          policy: z.record(z.unknown()).optional(),
        }),
        execute: async (input) => {
          const value = input as { id: string } & Parameters<Scheduler['update']>[1];
          const { id, ...changes } = value;
          return scheduler.update(id, changes);
        },
      });
      for (const [name, description, action] of [
        ['schedule.pause', 'Pause a durable schedule', (id: string) => scheduler.pause(id)],
        ['schedule.resume', 'Resume a durable schedule', (id: string) => scheduler.resume(id)],
        [
          'schedule.trigger',
          'Trigger a durable schedule immediately and wait for its task result',
          (id: string) => scheduler.trigger(id),
        ],
      ] as const) {
        this.register({
          name,
          description,
          permission: 'write',
          parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          input: z.object({ id: z.string().min(1) }),
          execute: async (input) => {
            const id = (input as { id: string }).id;
            await action(id);
            return { ok: true, id };
          },
        });
      }
      this.register({
        name: 'task.create',
        description:
          'Start a durable background agent task and return immediately with its task id',
        permission: 'write',
        parameters: {
          type: 'object',
          properties: { agentInput: { type: 'string' }, name: { type: 'string' } },
          required: ['agentInput'],
        },
        input: z.object({
          agentInput: z.string().trim().min(1).max(50_000),
          name: z.string().trim().max(200).optional(),
        }),
        execute: async (input) => {
          const value = input as { agentInput: string; name?: string };
          return scheduler.createTask(value.agentInput, value.name);
        },
      });
      this.register({
        name: 'task.list',
        description: 'List durable background and scheduled task states',
        permission: 'read',
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => ({ tasks: scheduler.listTasks() }),
      });
      this.register({
        name: 'task.cancel',
        description: 'Cancel a queued or running background task',
        permission: 'write',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        input: z.object({ id: z.string().min(1) }),
        execute: async (input) => {
          const id = (input as { id: string }).id;
          scheduler.cancelTask(id);
          return { ok: true, id };
        },
      });
    }
    if (services.providers) {
      const providers = services.providers;
      this.register({
        name: 'provider.list',
        description: 'Discover configured providers, their health, and available model catalogs',
        permission: 'read',
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => providers.catalog(),
      });
      this.register({
        name: 'provider.status',
        description: 'Report the active provider/model and current provider health',
        permission: 'read',
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => providers.catalog(),
      });
      this.register({
        name: 'provider.switch',
        description: 'Validate, persist, and activate a provider/model selection',
        permission: 'write',
        parameters: {
          type: 'object',
          properties: { provider: { type: 'string' }, model: { type: 'string' } },
          required: ['provider', 'model'],
        },
        input: z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1) }),
        execute: async (input) => {
          const value = input as { provider: string; model: string };
          const active = await providers.switch(value.provider, value.model);
          return { active, persisted: true };
        },
      });
    }
    if (services.mcp) {
      const mcp = services.mcp;
      this.register({
        name: 'mcp.status',
        description: 'Report authenticated MCP server connections, failures, and discovered tools',
        permission: 'read',
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => mcp.status(),
      });
      this.register({
        name: 'mcp.discover',
        description: 'Discover MCP tools allowed by the current permission context',
        permission: 'read',
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async (_input, context) => mcp.discover(context.permissions),
      });
      this.register({
        name: 'computer.status',
        description:
          'Report the configured permissioned computer-use MCP boundary without exposing credentials',
        permission: 'read',
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => {
          const status = mcp.status();
          return {
            enabled: status.servers.includes('computer'),
            server: 'computer',
            tools: status.tools.filter((tool) => tool.server === 'computer'),
            failure: status.failures.computer,
          };
        },
      });
      this.register({
        name: 'computer.use',
        description:
          'Use the configured cua-driver desktop boundary. Capture/list actions require read; input actions require execute. Capture first and use fresh element references.',
        permission: 'read',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'capture',
                'list_apps',
                'list_windows',
                'click',
                'double_click',
                'right_click',
                'middle_click',
                'drag',
                'scroll',
                'type',
                'key',
                'set_value',
              ],
            },
            arguments: { type: 'object' },
          },
          required: ['action'],
        },
        input: z.object({
          action: z.string().trim().min(1),
          arguments: z.record(z.unknown()).default({}),
        }),
        execute: async (input, context) => {
          const value = input as { action: string; arguments: Record<string, unknown> };
          return mcp.executeComputer(value.action, value.arguments, context.permissions);
        },
      });
      this.register({
        name: 'mcp.execute',
        description:
          'Execute one discovered MCP tool through the authenticated permission boundary',
        permission: 'execute',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' }, arguments: { type: 'object' } },
          required: ['name'],
        },
        input: z.object({
          name: z.string().trim().min(1),
          arguments: z.record(z.unknown()).default({}),
        }),
        execute: async (input, context) => {
          const value = input as { name: string; arguments: Record<string, unknown> };
          return mcp.execute(value.name, value.arguments, context.permissions);
        },
      });
    }
    if (services.media) {
      const media = services.media;
      this.register({
        name: 'media.inspect',
        description:
          'Inspect bounded local text, image, audio, video, PDF, DOCX, or XLSX media and extract safe artifacts',
        permission: 'read',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            extractAudio: { type: 'boolean' },
            extractFrames: { type: 'boolean' },
          },
          required: ['path'],
        },
        input: z.object({
          path: z.string().trim().min(1),
          extractAudio: z.boolean().default(false),
          extractFrames: z.boolean().default(false),
        }),
        execute: async (input) => {
          const value = input as { path: string; extractAudio?: boolean; extractFrames?: boolean };
          return media.inspect(value.path, {
            extractAudio: value.extractAudio,
            extractFrames: value.extractFrames,
          });
        },
      });
    }
    if (services.agents) {
      const agents = services.agents;
      this.register({
        name: 'agent.list',
        description: 'List explicitly allowlisted external-agent adapters without exposing secrets',
        permission: 'read',
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => ({ agents: agents.list() }),
      });
      this.register({
        name: 'agent.dispatch',
        description: 'Dispatch a bounded prompt to one configured external-agent adapter',
        permission: 'execute',
        parameters: {
          type: 'object',
          properties: { agent: { type: 'string' }, prompt: { type: 'string' } },
          required: ['agent', 'prompt'],
        },
        input: z.object({ agent: z.string().trim().min(1), prompt: z.string().trim().min(1) }),
        execute: async (input) => {
          const value = input as { agent: string; prompt: string };
          return agents.dispatch(value.agent, value.prompt);
        },
      });
    }
    void root;
  }

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }
  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name));
  }
  schemas(permissions?: PermissionContext): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    return this.list()
      .filter((tool) => !permissions || permissions.approved.has(tool.permission))
      .map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }));
  }
  async execute(name: string, input: unknown, context: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    assertPermission(context.permissions, tool.permission);
    return tool.execute(tool.input.parse(input), context);
  }
}
