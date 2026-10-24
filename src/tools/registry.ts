import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { abortableOperation } from '../core/async.js';
import { IdempotencyGuard } from '../core/idempotency.js';
import { ToolExecutionError } from '../core/tool-errors.js';
import { ToolInputError, malformedArgumentsKey } from '../core/tool-input.js';

import { z } from 'zod';

import type { RunArtifactCandidate, RunArtifactKind } from '../artifacts/registry.js';
import type { Scheduler } from '../core/scheduler.js';
import { runHostCommand } from '../host/command.js';
import type { ExternalAgentDispatcher } from '../integrations/agents.js';
import type { McpManager } from '../integrations/mcp.js';
import type { MediaProcessor } from '../integrations/media.js';
import type { SearchStack } from '../integrations/search.js';
import type { DatabaseStore } from '../memory/db.js';
import type { KnowledgeLearner } from '../memory/learning.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { type PermissionContext, assertPermission } from '../security/permissions.js';
import { redactText } from '../security/redaction.js';
import type { SkillLearner } from '../skills/learner.js';
import { SkillAvailabilityError, type SkillRegistry } from '../skills/registry.js';
import {
  copyWorkspaceFile,
  editWorkspaceFile,
  inspectWorkspaceFile,
  listWorkspaceDirectory,
  mkdirWorkspacePath,
  readWorkspaceFile,
  runWorkspaceCommand,
  searchWorkspace,
  statWorkspacePath,
  trashWorkspaceFile,
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
  repetition?: IdempotencyGuard;
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
  skills?: SkillRegistry;
  skillLearner?: SkillLearner;
  knowledge?: KnowledgeLearner;
  plugins?: PluginRegistry;
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
  authorize?(input: unknown, context: ToolContext): void;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}
export interface ToolAdmission {
  definition: ToolDefinition;
  input: unknown;
}

const empty = z.object({});
const githubCommands = new Set(['gh']);
const toolCostUnits: Record<ToolCostClass, number> = { low: 1, medium: 2, high: 4 };
const maxArtifactCandidatesPerToolCall = 32;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function explicitArtifactCandidate(value: unknown): RunArtifactCandidate | undefined {
  const candidate = recordValue(value);
  if (
    !candidate ||
    typeof candidate.kind !== 'string' ||
    typeof candidate.title !== 'string' ||
    typeof candidate.mimeType !== 'string'
  )
    return undefined;
  const metadata = recordValue(candidate.metadata);
  return {
    kind: candidate.kind as RunArtifactKind,
    title: candidate.title,
    mimeType: candidate.mimeType,
    ...(typeof candidate.workspacePath === 'string'
      ? { workspacePath: candidate.workspacePath }
      : typeof candidate.path === 'string'
        ? { workspacePath: candidate.path }
        : {}),
    ...(typeof candidate.content === 'string' ? { content: candidate.content } : {}),
    ...(typeof candidate.externalUrl === 'string'
      ? { externalUrl: candidate.externalUrl }
      : typeof candidate.url === 'string'
        ? { externalUrl: candidate.url }
        : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function mimeTypeForWorkspacePath(path: string): string {
  const types: Record<string, string> = {
    '.csv': 'text/csv',
    '.diff': 'text/x-diff',
    '.gif': 'image/gif',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.patch': 'text/x-diff',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.txt': 'text/plain',
    '.wav': 'audio/wav',
    '.webp': 'image/webp',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.zip': 'application/zip',
  };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function workspaceArtifactKind(path: string): RunArtifactKind {
  const extension = extname(path).toLowerCase();
  if (extension === '.diff' || extension === '.patch') return 'diff';
  if (/\b(?:junit|test[-_. ]?report|test[-_. ]?results?)\b/i.test(basename(path)))
    return 'test-report';
  if (
    /\bscreenshot\b/i.test(basename(path)) &&
    ['.jpeg', '.jpg', '.png', '.webp'].includes(extension)
  )
    return 'screenshot';
  return 'file';
}

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
      description:
        'List immediate non-protected files and directories at a workspace-relative path (default .), without recursive traversal. Returns entries with paths usable by the next tool call, total count, and an explicit truncated flag. Excludes build/dependency trees and private home application state.',
      permission: 'read',
      governance: governance('workspace', 'low', 'none', 'none', 'none', 48),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory; default .' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 1000,
            description: 'Maximum returned entries; default 200',
          },
        },
      },
      input: z.object({
        path: z.string().default('.'),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      execute: async (input, context) => {
        const { path, limit } = input as { path: string; limit: number };
        return listWorkspaceDirectory(context.root, path, limit);
      },
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
      name: 'workspace.edit',
      description:
        'Replace one unique exact text match in a workspace file; refuses ambiguous or missing matches.',
      permission: 'write',
      governance: governance('workspace', 'medium', 'none', 'workspace', 'profile', 24),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['path', 'oldText', 'newText'],
      },
      input: z.object({ path: z.string().min(1), oldText: z.string().min(1), newText: z.string() }),
      execute: async (input, context) => {
        const value = input as { path: string; oldText: string; newText: string };
        return editWorkspaceFile(context.root, value.path, value.oldText, value.newText);
      },
    });
    for (const operation of ['stat', 'mkdir', 'trash'] as const)
      this.register({
        name: `workspace.${operation}`,
        description:
          operation === 'stat'
            ? 'Check whether a workspace path exists and inspect size/type, including after trash or move.'
            : operation === 'mkdir'
              ? 'Create a workspace directory and missing parents.'
              : 'Move one regular workspace file to recoverable workspace-owned Freedesktop trash. Never permanently delete; refuses directories and symlinks. Read back with workspace.stat.',
        permission: operation === 'stat' ? 'read' : 'write',
        governance: governance(
          'workspace',
          operation === 'stat' ? 'low' : 'medium',
          'none',
          operation === 'stat' ? 'none' : 'workspace',
          operation === 'stat' ? 'none' : 'profile',
          24,
        ),
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        input: z.object({ path: z.string().min(1) }),
        execute: async (input, context) =>
          ({ stat: statWorkspacePath, mkdir: mkdirWorkspacePath, trash: trashWorkspaceFile })[
            operation
          ](context.root, (input as { path: string }).path),
      });
    for (const operation of ['copy', 'move'] as const)
      this.register({
        name: `workspace.${operation}`,
        description: `${operation === 'copy' ? 'Copy' : 'Move'} one regular workspace file without overwriting a destination. Move copies exclusively then trashes the source; a partial failure is reported, never hidden.`,
        permission: 'write',
        governance: governance('workspace', 'medium', 'none', 'workspace', 'profile', 24),
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, destination: { type: 'string' } },
          required: ['path', 'destination'],
        },
        input: z.object({ path: z.string().min(1), destination: z.string().min(1) }),
        execute: async (input, context) => {
          const value = input as { path: string; destination: string };
          return copyWorkspaceFile(
            context.root,
            value.path,
            value.destination,
            operation === 'move',
          );
        },
      });
    this.register({
      name: 'workspace.search',
      description:
        'Search UTF-8 workspace text within file, byte, traversal and result limits. Optional path narrows the scope. Oversized/binary/unreadable entries are skipped with diagnostics; complete:false is partial coverage, not proof of absence.',
      permission: 'read',
      governance: governance('workspace', 'low', 'none', 'none', 'none', 48),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          path: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['query'],
      },
      input: z.object({
        query: z.string().min(1),
        path: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      execute: async (input, context) => {
        const { query, ...options } = input as { query: string; path?: string; limit?: number };
        return searchWorkspace(context.root, query, { ...options, signal: context.signal });
      },
    });
    this.register({
      name: 'host.command',
      description:
        'Execute an installed host-account CLI with literal argv and optional stdin, including Himalaya, build/test tools and project scripts. This is NOT confined to the workspace: the program has the OS account access, including normal application configuration. Default Manual/Smart requires exact human approval unless a session scope was granted; user-selected Unguarded skips prompts. No implicit shell parsing. Use workspace.command for cheap allowlisted read-only probes. On nonzero/partial failure the run stops rather than retrying a possible external side effect.',
      permission: 'execute',
      governance: governance('host', 'high', 'host', 'unknown', 'profile', 24),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          stdin: { type: 'string', maxLength: 256000 },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 },
        },
        required: ['command'],
      },
      input: z.object({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        stdin: z.string().max(256000).optional(),
        timeoutMs: z.number().int().min(100).max(600000).optional(),
      }),
      authorize: (_input, context) => assertSubprocess(context),
      execute: async (input, context) => {
        const value = input as {
          command: string;
          args: string[];
          stdin?: string;
          timeoutMs?: number;
        };
        return runHostCommand(value.command, value.args, context.root, {
          stdin: value.stdin,
          timeoutMs: Math.min(value.timeoutMs ?? 30000, context.timeoutMs ?? 600000),
          signal: context.signal,
        });
      },
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
          'Persist an explicitly requested durable memory. Default scope is this workspace; choose profile only for an explicitly cross-workspace user preference. Automatic learning is handled separately after verified completion.',
        permission: 'write',
        governance: governance('memory', 'medium', 'configured', 'durable', 'profile', 16),
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', minLength: 1, maxLength: 50_000 },
            scope: {
              type: 'string',
              enum: ['workspace', 'profile'],
              description: 'Defaults to workspace; profile is for an explicitly global preference.',
            },
            metadata: { type: 'object' },
          },
          required: ['content'],
        },
        input: z.object({
          content: z.string().trim().min(1).max(50_000),
          scope: z.enum(['workspace', 'profile']).default('workspace'),
          metadata: z
            .record(z.string(), z.unknown())
            .default({})
            .refine(
              (value) => !Object.hasOwn(value, 'knowledge'),
              'knowledge metadata is reserved; use the top-level scope field',
            ),
        }),
        authorize: () => services.knowledge?.assertExplicitSaveAllowed(),
        execute: async (input, context) => {
          const value = input as {
            content: string;
            scope: 'workspace' | 'profile';
            metadata: Record<string, unknown>;
          };
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
          store.storeMemory(id, value.content, embedding, {
            ...value.metadata,
            knowledge: {
              version: 1,
              origin: 'explicit',
              state: 'active',
              scope: value.scope,
              workspaceRoot: context.root,
              sourceRunId: context.runId ?? null,
            },
          });
          return {
            id,
            stored: true,
            scope: value.scope,
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
        execute: async (input, context) => {
          const value = input as { query: string; limit: number };
          try {
            if (services.providers) {
              const embedding = await services.providers.get('ollama').embed(value.query);
              const semantic = store.searchMemory(embedding, value.limit, context.root);
              if (semantic.length) return { mode: 'semantic', results: semantic };
            }
          } catch (error) {
            return {
              mode: 'lexical',
              results: store.searchMemoryLexical(value.query, value.limit, context.root),
              warning: `Semantic search unavailable: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          return {
            mode: 'lexical',
            results: store.searchMemoryLexical(value.query, value.limit, context.root),
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
          policy: z.record(z.string(), z.unknown()).optional(),
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
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string', enum: ['once', 'interval', 'cron', 'manual', 'startup'] },
            expression: { type: 'string' },
            agentInput: { type: 'string' },
            enabled: { type: 'boolean' },
            policy: { type: 'object' },
          },
          required: ['id'],
        },
        input: z.object({
          id: z.string().min(1),
          name: z.string().trim().min(1).max(200).optional(),
          type: z.enum(['once', 'interval', 'cron', 'manual', 'startup']).optional(),
          expression: z.string().max(200).optional(),
          agentInput: z.string().trim().min(1).max(50_000).optional(),
          enabled: z.boolean().optional(),
          policy: z.record(z.string(), z.unknown()).optional(),
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
          'Start a durable background NUAAI run in its own scheduler session using configured scheduler permissions. Returns a task id, not completed work. Does not launch an external-agent adapter or inherit the caller conversation. Inspect outcomes with task.inspect.',
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
        execute: async (input, context) => {
          const value = input as { agentInput: string; name?: string };
          return scheduler.createTask(value.agentInput, value.name, context.runId);
        },
      });
      this.register({
        name: 'task.list',
        description:
          'List durable background and scheduled task states. For failure causes and linked run evidence call task.inspect; never infer a cause from status alone.',
        permission: 'read',
        governance: governance('scheduler', 'low', 'none', 'none', 'none', 24),
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => ({ tasks: scheduler.listTasks() }),
      });
      this.register({
        name: 'task.inspect',
        description:
          'Read bounded, redacted task diagnostics: linked run, original recorded failure, and diagnostic event IDs. Returns found:false for unknown IDs; never reruns a task or exposes prompts/instructions.',
        permission: 'read',
        governance: governance('scheduler', 'low', 'none', 'none', 'none', 24),
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        input: z.object({ id: z.string().min(1).max(200) }),
        execute: async (input) => {
          const id = (input as { id: string }).id;
          return scheduler.inspectTask(id) ?? { found: false, taskId: id };
        },
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
      if (mcp.status().tools.some((tool) => tool.server === 'computer'))
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
            arguments: z.record(z.string(), z.unknown()).default({}),
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
      if (mcp.status().tools.length > 0)
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
            arguments: z.record(z.string(), z.unknown()).default({}),
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
    if (services.skills) {
      const skills = services.skills;
      this.register({
        name: 'skill.list',
        description:
          'List registered reusable skill metadata; does not execute skill instructions.',
        permission: 'read',
        governance: governance('skills', 'low', 'none', 'none', 'none', 24),
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async () => ({ skills: skills.list() }),
      });
      this.register({
        name: 'skill.search',
        description: 'Search enabled reusable skills by name and trigger words.',
        permission: 'read',
        governance: governance('skills', 'low', 'none', 'none', 'none', 24),
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 25 },
          },
          required: ['query'],
        },
        input: z.object({
          query: z.string().trim().min(1).max(1000),
          limit: z.number().int().min(1).max(25).default(8),
        }),
        execute: async (input) => {
          const value = input as { query: string; limit: number };
          return { skills: skills.search(value.query, value.limit) };
        },
      });
      this.register({
        name: 'skill.load',
        description:
          'Retrieve enabled skill instructions, checking required tools. Expected unavailability returns loaded:false with a reason; do not claim the skill loaded. Does not execute scripts or expand permissions.',
        permission: 'read',
        governance: governance('skills', 'low', 'none', 'none', 'none', 24),
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        input: z.object({ name: z.string().trim().min(1).max(200) }),
        execute: async (input, context) => {
          const name = (input as { name: string }).name;
          try {
            return {
              loaded: true,
              ...skills.load(
                name,
                new Set(this.schemas(context.permissions).map((tool) => tool.name)),
              ),
            };
          } catch (error) {
            if (!(error instanceof SkillAvailabilityError)) throw error;
            return {
              loaded: false,
              name,
              reason: error.reason,
              message: error.message,
              unavailableTools: [...error.unavailableTools],
            };
          }
        },
      });
      if (services.skillLearner) {
        const learner = services.skillLearner;
        this.register({
          name: 'skill.create',
          description:
            'Create a durable instruction-only skill in the runtime private skill library. Requires action approval; never executes its instructions.',
          permission: 'write',
          governance: governance('skills', 'medium', 'none', 'durable', 'profile', 8),
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 64 },
              instructions: { type: 'string', minLength: 1, maxLength: 50000 },
            },
            required: ['name', 'instructions'],
          },
          input: z.object({
            name: z
              .string()
              .max(64)
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
            instructions: z.string().trim().min(1).max(50000),
          }),
          execute: async (input) => {
            const value = input as { name: string; instructions: string };
            return learner.create(value.name, value.instructions);
          },
        });
      }
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
        execute: async () => ({ agents: agents.list(), available: agents.available() }),
      });
      if (agents.available())
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
    if (services.plugins) {
      const plugins = services.plugins;
      this.register({
        name: 'plugin.list',
        description:
          'Discover enabled trusted plugins callable under current permissions; metadata only, not a health or sandbox guarantee',
        permission: 'read',
        governance: governance('plugins', 'low', 'configured', 'none', 'none', 24),
        parameters: { type: 'object', properties: {} },
        input: empty,
        execute: async (_input, context) => ({ plugins: plugins.discover(context.permissions) }),
      });
      this.register({
        name: 'plugin.execute',
        description:
          'Execute an explicitly trusted local plugin discovered by plugin.list. Runs host code, not an OS sandbox; requires current capabilities and action approval.',
        permission: 'execute',
        governance: governance('plugins', 'high', 'configured', 'unknown', 'profile', 8),
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' }, input: { type: 'object' } },
          required: ['name'],
        },
        input: z.object({
          name: z.string().min(1),
          input: z.record(z.string(), z.unknown()).default({}),
        }),
        authorize: (input, context) =>
          plugins.assertCallable((input as { name: string }).name, context.permissions),
        execute: async (input, context) => {
          const value = input as { name: string; input: Record<string, unknown> };
          plugins.assertCallable(value.name, context.permissions);
          return plugins.execute(value.name, value.input, context.signal);
        },
      });
    }
    void root;
  }

  register(tool: ToolDefinition): () => void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    if (!tool.governance.owner.trim()) throw new Error(`Tool owner is required: ${tool.name}`);
    if (!Number.isInteger(tool.governance.maxCallsPerRun) || tool.governance.maxCallsPerRun <= 0)
      throw new Error(`Tool maxCallsPerRun must be positive: ${tool.name}`);
    if (
      tool.governance.sideEffects !== 'none' &&
      (tool.governance.approval !== 'profile' || tool.permission === 'read')
    )
      throw new Error(`Side-effecting tool requires profile approval: ${tool.name}`);
    const registered: ToolDefinition = {
      ...tool,
      parameters: {
        ...tool.parameters,
        properties: {
          ...(tool.parameters.properties as Record<string, unknown> | undefined),
          requestApproval: {
            type: 'boolean',
            description:
              'Set true to request explicit human review when unsure of authorization. Never grants authority; ignored only in user-selected Unguarded mode.',
          },
        },
      },
    };
    this.tools.set(tool.name, registered);
    return () => {
      if (this.tools.get(tool.name) === registered) this.tools.delete(tool.name);
    };
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

  artifactCandidates(name: string, input: unknown, result: unknown): RunArtifactCandidate[] {
    const candidates: RunArtifactCandidate[] = [];
    const resultRecord = recordValue(result);
    const explicitValues = Array.isArray(resultRecord?.artifacts)
      ? resultRecord.artifacts
      : resultRecord?.artifact !== undefined
        ? [resultRecord.artifact]
        : [];
    for (const value of explicitValues) {
      const candidate = explicitArtifactCandidate(value);
      if (candidate) candidates.push(candidate);
    }

    const inputRecord = recordValue(input);
    if (name === 'workspace.write' && typeof inputRecord?.path === 'string') {
      const path = inputRecord.path;
      candidates.push({
        kind: workspaceArtifactKind(path),
        title: basename(path) || 'Workspace file',
        mimeType: mimeTypeForWorkspacePath(path),
        workspacePath: path,
        metadata: { sourcePath: path },
      });
    }
    if (name === 'web.search') {
      const results = Array.isArray(result)
        ? result
        : Array.isArray(resultRecord?.results)
          ? resultRecord.results
          : [];
      for (const value of results) {
        const entry = recordValue(value);
        if (!entry || typeof entry.url !== 'string') continue;
        candidates.push({
          kind: 'citation',
          title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : entry.url,
          mimeType: 'text/uri-list',
          externalUrl: entry.url,
          ...(typeof entry.source === 'string' ? { metadata: { source: entry.source } } : {}),
        });
      }
    }
    if ((name === 'web.fetch' || name === 'browser.open') && typeof resultRecord?.url === 'string')
      candidates.push({
        kind: 'citation',
        title:
          typeof resultRecord.title === 'string' && resultRecord.title.trim()
            ? resultRecord.title
            : resultRecord.url,
        mimeType: 'text/uri-list',
        externalUrl: resultRecord.url,
      });

    const unique = new Map<string, RunArtifactCandidate>();
    for (const candidate of candidates) {
      const key = JSON.stringify([
        candidate.kind,
        candidate.title,
        candidate.mimeType,
        candidate.workspacePath,
        candidate.externalUrl,
      ]);
      if (!unique.has(key)) unique.set(key, candidate);
      if (unique.size >= maxArtifactCandidatesPerToolCall) break;
    }
    return [...unique.values()];
  }

  previewAdmission(name: string, input: unknown, context: ToolContext): ToolAdmission {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    assertPermission(context.permissions, tool.permission);
    context.signal?.throwIfAborted();
    if (input && typeof input === 'object' && Object.hasOwn(input, malformedArgumentsKey))
      throw new ToolInputError('Provider supplied malformed JSON arguments');
    const validation = tool.input.safeParse(input);
    if (!validation.success) throw new ToolInputError(validation.error.message);
    const parsed = validation.data;
    tool.authorize?.(parsed, context);
    return { definition: tool, input: parsed };
  }
  async execute(
    name: string,
    input: unknown,
    context: ToolContext,
    onAuthorized?: () => void,
  ): Promise<unknown> {
    const { definition: tool, input: parsed } = this.previewAdmission(name, input, context);
    reserveToolBudget(tool, context.budget);
    if (context.budget && !context.budget.repetition)
      context.budget.repetition = new IdempotencyGuard();
    const guard = context.budget?.repetition;
    const key = guard?.key(context.root, name, parsed) ?? '';
    await guard?.before(
      key,
      name,
      tool.governance.sideEffects,
      tool.permission === 'execute',
      context.signal,
    );
    onAuthorized?.();
    context.signal?.throwIfAborted();
    const deadline = new AbortController();
    const timeoutReason = new Error(`Tool timed out after ${context.timeoutMs}ms`);
    const signal = context.signal
      ? AbortSignal.any([context.signal, deadline.signal])
      : deadline.signal;
    const timeout =
      context.timeoutMs === undefined
        ? undefined
        : setTimeout(() => deadline.abort(timeoutReason), context.timeoutMs);
    const executionContext = { ...context, signal };
    let launched = false;
    try {
      const result = await abortableOperation(() => {
        launched = true;
        return tool.execute(parsed, executionContext);
      }, signal);
      signal.throwIfAborted();
      guard?.succeeded(key, name, tool.governance.sideEffects, result);
      return result;
    } catch (error) {
      const reason =
        signal.reason instanceof Error
          ? redactText(signal.reason.message).slice(0, 300)
          : 'Abort requested';
      const failure =
        signal.aborted && !(error instanceof ToolExecutionError)
          ? new ToolExecutionError(
              launched
                ? `Tool execution interrupted after launch (${reason}). The underlying operation may still run and side effects may have occurred. Do not retry automatically; inspect the destination first.`
                : `Tool was not executed (${reason}).`,
              signal.reason === timeoutReason ? 'TOOL_TIMEOUT' : 'TOOL_INTERRUPTED',
              launched ? 'uncertain' : 'not_executed',
              launched ? 'inspect_destination' : 'change_approach',
            )
          : error;
      guard?.failed(key, tool.governance.sideEffects, failure);
      throw failure;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
