import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultRuntimeConfig } from '../src/config/index.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { createToken } from '../src/gateway/token.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import type { ProviderRequest } from '../src/providers/types.js';
import { permissionContextForProfile } from '../src/security/permissions.js';
import { type GatewayServices, startServer } from '../src/server.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { initWorkspace } from '../src/workspace/fs.js';

it('provides meaningful redacted pending-action review without persisting or retaining the body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-approval-review-'));
  await initWorkspace(root);
  const store = new DatabaseStore(openAppDatabase(root));
  const provider = {
    name: 'approval-review-test',
    model: 'test',
    async *stream(request: ProviderRequest) {
      if (!request.messages.some((message) => message.role === 'tool')) {
        yield {
          type: 'tool_call' as const,
          id: 'review-write',
          name: 'workspace.write',
          arguments: {
            path: 'review.txt',
            content: 'AUDIT_READABLE_CONTENT\npassword=REVIEW_SECRET_SENTINEL',
          },
        };
      } else yield { type: 'done' as const, text: 'The approved file was written.' };
    },
    health: async () => ({ name: 'approval-review-test', available: true, detail: 'fixture' }),
    embed: async () => [],
  };
  const providers = {
    get: () => provider,
    list: () => [provider.name],
    health: async () => [],
  } as never;
  const config = defaultRuntimeConfig(root);
  config.provider.name = provider.name;
  config.provider.model = provider.model;
  const runtime = new AgentRuntime({
    root,
    config,
    store,
    providers,
    tools: new ToolRegistry(
      root,
      undefined,
      { browserEnabled: false, searchEnabled: false },
      { store },
    ),
  });
  const authSecret = 'approval-review-fixture-auth-at-least-32-bytes';
  const server = await startServer({
    root,
    host: '127.0.0.1',
    port: 0,
    authSecret,
    runtime,
    store,
    providers,
  } as unknown as GatewayServices);
  let runId: string | undefined;
  try {
    const { thread } = runtime.createSession('Approval review');
    runId = runtime.startRun({
      threadId: thread.id,
      input: 'Write the agreed content to review.txt.',
      permissions: permissionContextForProfile('operator'),
      permissionSource: 'web',
    }).id;
    await expect.poll(() => store.getRun(runId as string)?.status).toBe('paused');
    const headers = {
      authorization: `Bearer ${createToken({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 300 }, authSecret)}`,
    };
    const getApprovals = async (status: string) => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/approvals?status=${status}`,
        { headers },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        approvals: Array<{
          id: string;
          preview: { fields: Array<{ label: string; value: string }> };
        }>;
      };
    };
    const pending = (await getApprovals('pending')).approvals[0];
    expect(pending).toBeDefined();
    const preview = JSON.stringify(pending.preview);
    expect(preview).toContain('AUDIT_READABLE_CONTENT');
    expect(preview).not.toContain('REVIEW_SECRET_SENTINEL');
    const persisted = store.getApprovalRequest(pending.id);
    expect(persisted?.argumentsPreview).not.toContain('AUDIT_READABLE_CONTENT');
    expect(persisted?.argumentsPreview).not.toContain('REVIEW_SECRET_SENTINEL');
    runtime.cancelRun(runId);
    await runtime.waitForRun(runId);
    const cancelled = (await getApprovals('denied')).approvals.find(
      (approval) => approval.id === pending.id,
    );
    expect(cancelled).toBeDefined();
    expect(JSON.stringify(cancelled?.preview)).not.toContain('AUDIT_READABLE_CONTENT');
  } finally {
    if (runId && ['queued', 'running', 'paused'].includes(store.getRun(runId)?.status ?? ''))
      runtime.cancelRun(runId);
    await runtime.shutdown();
    await server.close();
    store.close();
  }
});
