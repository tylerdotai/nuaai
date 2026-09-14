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
  budget?: ToolBudget;
  timeoutMs?: number;
  signal?: AbortSignal;
  threadId?: string;
  runId?: string;
}
export type ToolCostClass = 'low' | 'medium' | 'high';
export type ToolAuthMode = 'none' | 'host' | 'configured';
export type ToolSideEffects = 'none' | 'workspace' | 'durable' | 'external' | 'unknown';
export type ToolApprovalPolicy = 'none' | 'profile';
export type ToolBudgetFailureReason =
  | 'tool_budget_exhausted'
  | 'tool_cost_budget_exhausted'
  | 'per_tool_budget_exhausted';
export interface ToolGovernance {
  owner: string;
  costClass: ToolCostClass;
  authMode: ToolAuthMode;
  sideEffects: ToolSideEffects;
  approval: ToolApprovalPolicy;
  maxCallsPerRun: number;
}
export interface ToolBudget {
  maxCalls: number;
  maxCostUnits: number;
  calls: number;
  costUnits: number;
  callsByTool: Map<string, number>;
}
export class ToolBudgetError extends Error {
  constructor(
    message: string,
    readonly reason: ToolBudgetFailureReason,
  ) {
    super(message);
    this.name = 'ToolBudgetError';
  }
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
  governance: ToolGovernance;
  parameters: Record<string, unknown>;
  input: z.ZodType<unknown>;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}

const empty = z.object({});
const githubCommands = new Set(['gh']);
const toolCostUnits: Record<ToolCostClass, number> = { low: 1, medium: 2, high: 4 };

function governance(
  owner: string,
  costClass: ToolCostClass,
  authMode: ToolAuthMode,
  sideEffects: ToolSideEffects,
  approval: ToolApprovalPolicy,
  maxCallsPerRun: number,
): ToolGovernance {
  return { owner, costClass, authMode, sideEffects, approval, maxCallsPerRun };
}

export function createToolBudget(maxCalls: number, maxCostUnits: number): ToolBudget {
  return { maxCalls, maxCostUnits, calls: 0, costUnits: 0, callsByTool: new Map() };
}

function reserveToolBudget(tool: ToolDefinition, budget: ToolBudget | undefined): void {
  if (!budget) return;
  const callsForTool = budget.callsByTool.get(tool.name) ?? 0;
  if (callsForTool >= tool.governance.maxCallsPerRun)
    throw new ToolBudgetError(
      `Per-tool call budget exhausted for ${tool.name}`,
      'per_tool_budget_exhausted',
    );
  if (budget.calls >= budget.maxCalls)
    throw new ToolBudgetError('The run tool-call budget is exhausted', 'tool_budget_exhausted');
  const costUnits = toolCostUnits[tool.governance.costClass];
  if (budget.costUnits + costUnits > budget.maxCostUnits)
    throw new ToolBudgetError(
      'The run tool-cost budget is exhausted',
      'tool_cost_budget_exhausted',
    );
  budget.calls += 1;
  budget.costUnits += costUnits;
  budget.callsByTool.set(tool.name, callsForTool + 1);
}

function assertNetwork(context: ToolContext): void {
  if (!context.permissions.capabilities.network) throw new Error('Network capability required');
}

function assertSubprocess(context: ToolContext): void {
  if (!context.permissions.capabilities.subprocess)
    throw new Error('Subprocess capability required');
}

function githubError(result: { stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout).trim().slice(0, 2_000);
}

export class ToolRegistry {
  readonly supportsAdmissionCallback = true;
  private readonly tools = new Map<string, ToolDefinition>();
  constructor(
    root: string,
    searchStack?: SearchStack,
    options: { browserEnabled?: boolean; searchEnabled?: boolean } = {},
    services: ToolServices = {},
  ) {
    this.register({
      name: 'workspace.list',
      description: 'List non-protected files in the NUAAI workspace',
      permission: 'read',
      governance: governance('workspace', 'low', 'none', 'none', 'none', 48),
      parameters: { type: 'object', properties: {} },
      input: empty,
      execute: async (_input, context) => listWorkspaceFiles(context.root),
    });
    this.register({
      name: 'workspace.read',
      description: 'Read a text file in the NUAAI workspace',
      permission: 'read',
      governance: governance('workspace', 'low', 'none', 'none', 'none', 48),
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
      governance: governance('workspace', 'low', 'none', 'none', 'none', 48),
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
      governance: governance('workspace', 'medium', 'none', 'workspace', 'profile', 16),
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
      governance: governance('workspace', 'low', 'none', 'none', 'none', 48),
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
        'Run one explicitly allowlisted read-oriented command (cat, date, df, echo, free, head, printf, ps, pwd, stat, tail, uname, uptime, wc, which, or whoami). Put arguments in args. Protected runtime and credential files remain inaccessible, subprocess environments are minimal, and shell operators such as &&, ;, |, and redirects are rejected; issue separate tool calls instead of chaining commands.',
      permission: 'execute',
      governance: governance('workspace', 'medium', 'host', 'none', 'profile', 24),
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
          cancelSignal: context.signal,
        });
      },
    });
    this.register({
      name: 'github.auth',
      description:
        'Check GitHub CLI authentication through the bounded gh command and return only sanitized account/status information',
      permission: 'execute',
      governance: governance('github', 'medium', 'host', 'none', 'profile', 16),
      parameters: { type: 'object', properties: {} },
      input: empty,
      execute: async (_input, context) => {
        assertNetwork(context);
        assertSubprocess(context);
        const result = await runWorkspaceCommand('gh', ['auth', 'status'], context.root, {
          timeoutMs: context.timeoutMs,
          allowedCommands: githubCommands,
        });
        const account = `${result.stdout}\n${result.stderr}`.match(/account\s+([^\s(]+)/i)?.[1];
        return {
          exitCode: result.exitCode,
          authenticated: result.exitCode === 0,
          ...(account ? { account } : {}),
          ...(result.exitCode === 0 ? {} : { error: githubError(result) }),
        };
      },
    });
    this.register({
      name: 'github.repo.list',
      description:
        'List repositories through gh with an enforced bounded limit; use mode count for an exact small count or rows for structured repository data',
      permission: 'execute',
      governance: governance('github', 'medium', 'host', 'none', 'profile', 16),
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          mode: { type: 'string', enum: ['count', 'rows'] },
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
        },
      },
      input: z.object({
        owner: z.string().trim().min(1).max(200).optional(),
        mode: z.enum(['count', 'rows']).default('count'),
        limit: z.number().int().min(1).max(1_000).default(1_000),
      }),
      execute: async (input, context) => {
        assertNetwork(context);
        assertSubprocess(context);
        const value = input as { owner?: string; mode: 'count' | 'rows'; limit: number };
        const args = ['repo', 'list'];
        if (value.owner) args.push(value.owner);
        args.push(
          '--limit',
          String(value.limit),
          '--json',
          'nameWithOwner,description,isPrivate,isArchived,updatedAt,url',
        );
        if (value.mode === 'count') {
          args.push('--jq', 'length');
          const result = await runWorkspaceCommand('gh', args, context.root, {
            timeoutMs: context.timeoutMs,
            allowedCommands: githubCommands,
          });
          const count = Number.parseInt(result.stdout.trim(), 10);
          return result.exitCode === 0 && Number.isInteger(count)
            ? { exitCode: result.exitCode, count, limit: value.limit }
            : { exitCode: result.exitCode, error: githubError(result), limit: value.limit };
        }
        const result = await runWorkspaceCommand('gh', args, context.root, {
          timeoutMs: context.timeoutMs,
          allowedCommands: githubCommands,
        });
        if (result.exitCode !== 0) return { exitCode: result.exitCode, error: githubError(result) };
        try {
          const repositories = JSON.parse(result.stdout) as unknown;
          if (!Array.isArray(repositories))
            throw new Error('GitHub returned a non-array repository result');
          return { exitCode: result.exitCode, count: repositories.length, repositories };
        } catch (error) {
          return {
            exitCode: result.exitCode,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
    if (searchStack && (options.searchEnabled ?? true)) {
      this.register({
        name: 'web.search',
        description: 'Search the web through local SearXNG with DuckDuckGo fallback',
        permission: 'read',
        governance: governance('web', 'medium', 'configured', 'none', 'none', 24),
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
      if (options.browserEnabled ?? true)
        this.register({
          name: 'web.fetch',
          description: 'Extract a web page through guarded Playwright browser automation',
          permission: 'read',
          governance: governance('web', 'medium', 'configured', 'none', 'none', 24),
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
    }
    if (searchStack && (options.browserEnabled ?? true))
      this.register({
        name: 'browser.open',
        description: 'Open a web page with headless Playwright browser automation',
        permission: 'read',
        governance: governance('browser', 'medium', 'configured', 'none', 'none', 24),
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
    if (services.store) {
      const store = services.store;
      this.register({
        name: 'run.history',
        description:
          'List recent run outcomes for the current conversation thread, including bounded inputs and failure outputs',
        permission: 'read',
        governance: governance('runtime', 'low', 'none', 'none', 'none', 24),
        parameters: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
        },
        input: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
        execute: async (input, context) => {
          if (!context.threadId) throw new Error('Current thread is unavailable');
          const limit = (input as { limit: number }).limit;
          return {
            threadId: context.threadId,
            runs: store.listRuns(context.threadId, limit).map((run) => ({
              id: run.id,
              status: run.status,
              provider: run.provider,
              model: run.model,
              input: run.input.slice(0, 2_000),
              output: run.output.slice(0, 2_000),
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
            })),
          };
        },
      });
      this.register({
        name: 'memory.store',
        description:
          'Persist a durable memory with optional Ollama embedding and redacted metadata',
        permission: 'write',
        governance: governance('memory', 'medium', 'configured', 'durable', 'profile', 16),
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
        governance: governance('memory', 'medium', 'configured', 'none', 'none', 24),
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
              results: store.searchMemoryLexical(value.query, value.limit),
              warning: `Semantic search unavailable: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          return {
            mode: 'lexical',
            results: store.searchMemoryLexical(value.query, value.limit),
          };
        },
      });
      this.register({
        name: 'memory.forget',
        description: 'Permanently remove one durable memory record by id',
        permission: 'write',
        governance: governance('memory', 'low', 'none', 'durable', 'profile', 16),
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
        governance: governance('scheduler', 'high', 'none', 'durable', 'profile', 8),
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
        governance: governance('scheduler', 'low', 'none', 'none', 'none', 24),
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => ({ schedules: scheduler.list() }),
      });
      this.register({
        name: 'schedule.update',
        description: 'Update a durable schedule',
        permission: 'write',
        governance: governance('scheduler', 'medium', 'none', 'durable', 'profile', 16),
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
          governance:
            name === 'schedule.trigger'
              ? governance('scheduler', 'high', 'none', 'external', 'profile', 8)
              : governance('scheduler', 'medium', 'none', 'durable', 'profile', 16),
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
        governance: governance('scheduler', 'high', 'none', 'external', 'profile', 8),
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
        governance: governance('scheduler', 'low', 'none', 'none', 'none', 24),
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => ({ tasks: scheduler.listTasks() }),
      });
      this.register({
        name: 'task.cancel',
        description: 'Cancel a queued or running background task',
        permission: 'write',
        governance: governance('scheduler', 'medium', 'none', 'durable', 'profile', 16),
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
        governance: governance('provider', 'low', 'configured', 'none', 'none', 24),
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => providers.catalog(),
      });
      this.register({
        name: 'provider.status',
        description: 'Report the active provider/model and current provider health',
        permission: 'read',
        governance: governance('provider', 'low', 'configured', 'none', 'none', 24),
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => providers.catalog(),
      });
      this.register({
        name: 'provider.switch',
        description: 'Validate, persist, and activate a provider/model selection',
        permission: 'write',
        governance: governance('provider', 'medium', 'configured', 'durable', 'profile', 8),
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
        governance: governance('mcp', 'low', 'configured', 'none', 'none', 24),
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => mcp.status(),
      });
      this.register({
        name: 'mcp.discover',
        description: 'Discover MCP tools allowed by the current permission context',
        permission: 'read',
        governance: governance('mcp', 'low', 'configured', 'none', 'none', 24),
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async (_input, context) => mcp.discover(context.permissions),
      });
      this.register({
        name: 'computer.status',
        description:
          'Report the configured permissioned computer-use MCP boundary without exposing credentials',
        permission: 'read',
        governance: governance('computer', 'low', 'configured', 'none', 'none', 24),
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
          'Use the configured cua-driver desktop boundary. All capture, list, click, scroll, key, and text-input actions require execute permission. Capture first and use fresh element references.',
        permission: 'execute',
        governance: governance('computer', 'high', 'configured', 'external', 'profile', 8),
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
          return mcp.executeComputer(
            value.action,
            value.arguments,
            context.permissions,
            context.signal,
          );
        },
      });
      this.register({
        name: 'mcp.execute',
        description:
          'Execute one discovered MCP tool through the authenticated permission boundary',
        permission: 'execute',
        governance: governance('mcp', 'high', 'configured', 'unknown', 'profile', 8),
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
          return mcp.execute(value.name, value.arguments, context.permissions, context.signal);
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
        governance: governance('media', 'medium', 'none', 'none', 'none', 16),
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
        governance: governance('agent', 'low', 'configured', 'none', 'none', 24),
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => ({ agents: agents.list() }),
      });
      this.register({
        name: 'agent.dispatch',
        description: 'Dispatch a bounded prompt to one configured external-agent adapter',
        permission: 'execute',
        governance: governance('agent', 'high', 'configured', 'unknown', 'profile', 8),
        parameters: {
          type: 'object',
          properties: { agent: { type: 'string' }, prompt: { type: 'string' } },
          required: ['agent', 'prompt'],
        },
        input: z.object({ agent: z.string().trim().min(1), prompt: z.string().trim().min(1) }),
        execute: async (input, context) => {
          const value = input as { agent: string; prompt: string };
          return agents.dispatch(value.agent, value.prompt, context.signal);
        },
      });
    }
    void root;
  }

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    if (!tool.governance.owner.trim()) throw new Error(`Tool owner is required: ${tool.name}`);
    if (!Number.isInteger(tool.governance.maxCallsPerRun) || tool.governance.maxCallsPerRun <= 0)
      throw new Error(`Tool maxCallsPerRun must be positive: ${tool.name}`);
    if (
      tool.governance.sideEffects !== 'none' &&
      (tool.governance.approval !== 'profile' || tool.permission === 'read')
    )
      throw new Error(`Side-effecting tool requires profile approval: ${tool.name}`);
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
  async execute(
    name: string,
    input: unknown,
    context: ToolContext,
    onAuthorized?: () => void,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    assertPermission(context.permissions, tool.permission);
    context.signal?.throwIfAborted();
    const parsed = tool.input.parse(input);
    reserveToolBudget(tool, context.budget);
    onAuthorized?.();
    context.signal?.throwIfAborted();
    const result = await tool.execute(parsed, context);
    context.signal?.throwIfAborted();
    return result;
  }
}
