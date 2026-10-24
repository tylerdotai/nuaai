import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import { CodexResponsesProvider } from '../src/providers/codex-responses.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { ToolRegistry } from '../src/tools/registry.js';

it.each(['codex', 'ollama', 'ollama-native'] as const)(
  '%s rejects malformed arguments without executing inferred commands, then accepts a schema-valid model repair',
  async (transport) => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-syntax-repair-'));
    const project = join(root, 'project');
    await mkdir(project);
    await writeFile(join(project, 'notes.txt'), 'actual notes');
    const authPath = join(root, 'synthetic-auth.json');
    const token = `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.signature`;
    await writeFile(authPath, JSON.stringify({ tokens: { access_token: token } }));
    let turns = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/embed')) return Response.json({ embeddings: [[]] });
      if (String(url).endsWith('/embeddings')) return Response.json({ data: [{ embedding: [] }] });
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      turns += 1;
      const wire = (
        body.tools as Array<{
          name?: string;
          description?: string;
          function?: { name: string; description: string };
        }>
      )
        .map((entry) => entry.function ?? entry)
        .find(
          (entry) =>
            entry.name === 'workspace_list' ||
            entry.name === 'workspace.list' ||
            entry.description?.includes('workspace.list'),
        );
      const args =
        turns === 1 ? '{"path":"."; "command":"touch SHOULD_NOT_EXIST"}' : '{"path":"."}';
      if (transport === 'ollama-native')
        return new Response(
          `${JSON.stringify({ message: turns <= 2 ? { content: '', tool_calls: [{ id: `syntax-${turns}`, function: { name: wire?.name, arguments: args } }] } : { content: 'The workspace contains notes.txt.' }, done: true })}\n`,
        );
      if (transport === 'ollama')
        return Response.json({
          choices: [
            {
              message:
                turns <= 2
                  ? {
                      content: '',
                      tool_calls: [
                        { id: `syntax-${turns}`, function: { name: wire?.name, arguments: args } },
                      ],
                    }
                  : { content: 'The workspace contains notes.txt.' },
            },
          ],
        });
      const events =
        turns <= 2
          ? [
              {
                type: 'response.output_item.done',
                item: {
                  type: 'function_call',
                  call_id: `syntax-${turns}`,
                  name: wire?.name,
                  arguments: args,
                },
              },
            ]
          : [{ type: 'response.output_text.delta', delta: 'The workspace contains notes.txt.' }];
      return new Response(
        [...events, { type: 'response.completed', response: { status: 'completed', output: [] } }]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchFn);
    const provider =
      transport === 'codex'
        ? new CodexResponsesProvider({ model: 'gpt-fixture', authPath, fetchFn })
        : new OllamaProvider({
            model: 'gpt-fixture',
            baseUrl:
              transport === 'ollama-native'
                ? 'http://fixture.invalid'
                : 'http://fixture.invalid/v1',
            embeddingModel: 'fixture',
          });
    const store = new DatabaseStore(openAppDatabase(root));
    const tools = new ToolRegistry(root);
    const runtime = new AgentRuntime({
      root,
      store,
      config: defaultRuntimeConfig(root),
      tools,
      providers: { get: () => provider, list: () => [transport] } as never,
    });
    try {
      const created = runtime.createSession('Syntax recovery', undefined, undefined, {
        workspaceRoot: project,
      });
      const run = runtime.startRun({
        threadId: created.thread.id,
        provider: transport === 'codex' ? 'codex' : 'ollama',
        input: 'List the current workspace once and report what it contains.',
      });
      const result = await runtime.waitForRun(run.id);
      expect(result.status, result.output).toBe('completed');
      expect(JSON.stringify(bodies[1])).toContain('INVALID_TOOL_ARGUMENTS');
      expect(
        store
          .listRecentEventsForRun(run.id, 100)
          .filter((event) => event.type === 'tool.completed'),
      ).toHaveLength(1);
      await expect(access(join(project, 'SHOULD_NOT_EXIST'))).rejects.toThrow();
    } finally {
      await runtime.shutdown();
      store.close();
      vi.unstubAllGlobals();
    }
  },
  15_000,
);
