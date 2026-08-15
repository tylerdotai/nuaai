import { z } from 'zod';

import type { SearchStack } from '../integrations/search.js';
import { type PermissionContext, assertPermission } from '../security/permissions.js';
import {
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

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  constructor(root: string, searchStack?: SearchStack, options: { browserEnabled?: boolean } = {}) {
    this.register({
      name: 'workspace.list',
      description: 'List files in the NUAAI workspace',
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
      description: 'Run an explicitly allowlisted workspace command',
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
