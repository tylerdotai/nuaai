import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { RunArtifactRegistry } from '../src/artifacts/registry.js';
import { defaultRuntimeConfig } from '../src/config/index.js';
import {
  type ApprovalRequestView,
  ApprovalStateError,
  approvalPayloadHash,
  canonicalizeApprovalArguments,
  publicApprovalRequest,
} from '../src/core/approvals.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { createToken } from '../src/gateway/token.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderStreamEvent,
} from '../src/providers/types.js';
import type { PermissionContext } from '../src/security/permissions.js';
import { type GatewayServices, startServer } from '../src/server.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { initialTuiState, reduceTuiEvent } from '../src/ui/tui-state.js';
import { ApprovalInbox } from '../src/web/views.js';

const stores: DatabaseStore[] = [];
const handles: Array<{ close(): Promise<void> }> = [];

async function makeRoot(prefix = 'nuaai-action-approval-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function makeStore(root: string): DatabaseStore {
  const store = new DatabaseStore(openAppDatabase(root));
  stores.push(store);
  return store;
}

function permissions(): PermissionContext {
  return {
    approved: new Set(['read', 'write', 'execute']),
    capabilities: { filesystem: true, subprocess: true, network: true },
  };
}

function providerMap(provider: ProviderAdapter): never {
  return {
    get: () => provider,
    list: () => [provider.name],
    active: () => ({ name: provider.name, model: provider.model }),
    health: async () => [],
  } as never;
}

function runtimeProvider(name = 'test'): ProviderAdapter {
  return {
    name,
    model: 'test-model',
    async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      if (!request.messages.some((message) => message.role === 'tool')) {
        yield {
          type: 'tool_call',
          id: 'write-call',
          name: 'workspace.write',
          arguments: { content: 'approved content', path: 'approved.txt' },
        };
        yield { type: 'done', text: '' };
        return;
      }
      yield { type: 'done', text: 'Approved write completed.' };
    },
    async embed() {
      return [];
    },
    async health() {
      return { name, available: true, detail: 'ready' };
    },
  };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for state');
}

function approvalInput(overrides: Record<string, unknown> = {}) {
  const canonicalArguments = canonicalizeApprovalArguments({ path: 'notes.txt', content: 'safe' });
  return {
    id: 'approval-1',
    runId: 'run-1',
    threadId: 'thread-1',
    sessionId: 'session-1',
    toolCallId: `call-${String(overrides.id ?? 'approval-1')}`,
    toolName: 'workspace.write',
    canonicalArguments,
    payloadHash: approvalPayloadHash('run-1', 'workspace.write', canonicalArguments),
    requiredPermission: 'write' as const,
    permissionSource: 'web',
    risk: 'medium · workspace',
    target: 'notes.txt',
    providerOwned: false,
    expiresAt: 2_000,
    ...overrides,
  };
}

function approvalView(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    id: 'approval-1',
    runId: 'run-1',
    threadId: 'thread-1',
    toolName: 'workspace.write',
    status: 'pending',
    payloadHash: 'a'.repeat(64),
    target: 'notes.txt',
    risk: 'medium · workspace',
    preview: {
      version: 1,
      kind: 'workspace.write',
      summary: 'Write text file',
      fields: [
        { label: 'Path', value: 'notes.txt' },
        { label: 'Content size', value: '16 UTF-8 bytes' },
        { label: 'Content SHA-256', value: 'b'.repeat(64) },
      ],
      context: { source: 'web', client: 'Web client', sessionId: 'session-1' },
    },
    providerOwned: false,
    createdAt: 1_000,
    expiresAt: 61_000,
    ...overrides,
  };
}

afterEach(async () => {
  while (handles.length) await handles.pop()?.close();
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

describe('payload-bound approval state machine', () => {
  it('canonicalizes object keys deterministically and binds the hash to run, tool, and payload', () => {
    const left = canonicalizeApprovalArguments({ z: 1, nested: { b: true, a: ['x', 2] } });
    const right = canonicalizeApprovalArguments({ nested: { a: ['x', 2], b: true }, z: 1 });
    expect(left).toBe(right);
    expect(approvalPayloadHash('run-a', 'tool.a', left)).toBe(
      approvalPayloadHash('run-a', 'tool.a', right),
    );
    expect(approvalPayloadHash('run-b', 'tool.a', left)).not.toBe(
      approvalPayloadHash('run-a', 'tool.a', left),
    );
    expect(approvalPayloadHash('run-a', 'tool.b', left)).not.toBe(
      approvalPayloadHash('run-a', 'tool.a', left),
    );
    expect(
      approvalPayloadHash('run-a', 'tool.a', canonicalizeApprovalArguments({ z: 2 })),
    ).not.toBe(approvalPayloadHash('run-a', 'tool.a', left));
  });

  it('rejects exact payload mismatch, replay, expiry, and concurrent conflicting decisions', async () => {
    const store = makeStore(await makeRoot());
    store.createApprovalRequest(approvalInput(), 1_000);
    expect(store.decideApprovalRequest('approval-1', 'approved', 1_100).status).toBe('approved');
    expect(() =>
      store.claimApprovalExecution(
        'approval-1',
        {
          runId: 'run-1',
          toolName: 'workspace.write',
          canonicalArguments: canonicalizeApprovalArguments({ path: 'other.txt', content: 'safe' }),
        },
        1_200,
      ),
    ).toThrow('payload');
    expect(
      store.claimApprovalExecution(
        'approval-1',
        {
          runId: 'run-1',
          toolName: 'workspace.write',
          canonicalArguments: approvalInput().canonicalArguments,
        },
        1_200,
      ).status,
    ).toBe('executed');
    expect(() =>
      store.claimApprovalExecution(
        'approval-1',
        {
          runId: 'run-1',
          toolName: 'workspace.write',
          canonicalArguments: approvalInput().canonicalArguments,
        },
        1_300,
      ),
    ).toThrow('already consumed');

    store.createApprovalRequest(approvalInput({ id: 'expired', expiresAt: 1_500 }), 1_000);
    expect(() => store.decideApprovalRequest('expired', 'approved', 1_500)).toThrow('expired');
    expect(store.getApprovalRequest('expired')?.status).toBe('expired');

    store.createApprovalRequest(approvalInput({ id: 'race' }), 1_000);
    const outcomes = ['approved', 'denied'].map((decision) => {
      try {
        return store.decideApprovalRequest('race', decision as 'approved' | 'denied', 1_200).status;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(
      outcomes.filter((outcome) => outcome === 'approved' || outcome === 'denied'),
    ).toHaveLength(1);
    expect(store.getApprovalRequest('race')?.status).toBe('approved');
  });

  it('persists pending requests and redacted bounded execution metadata across reopen', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    store.createApprovalRequest(
      approvalInput({
        target: 'Bearer private-token',
        canonicalArguments: canonicalizeApprovalArguments({
          path: 'notes.txt',
          apiKey: 'private-key',
        }),
        payloadHash: approvalPayloadHash(
          'run-1',
          'workspace.write',
          canonicalizeApprovalArguments({ path: 'notes.txt', apiKey: 'private-key' }),
        ),
      }),
      1_000,
    );
    expect(store.listApprovalRequests()).toEqual([
      expect.objectContaining({ id: 'approval-1', status: 'pending' }),
    ]);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = makeStore(root);
    const pending = reopened.getApprovalRequest('approval-1');
    expect(pending).toMatchObject({ status: 'pending', target: 'notes.txt' });
    expect(JSON.stringify(pending)).not.toContain('private-key');
  });
});

describe('runtime approval boundary', () => {
  it('performs no side effect before approval and executes the exact action once after approval', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = runtimeProvider();
    const config = defaultRuntimeConfig(root);
    const runtime = new AgentRuntime({
      root,
      config: {
        ...config,
        limits: { ...config.limits, maxToolCalls: 1, maxToolCostUnits: 2 },
      },
      store,
      providers: providerMap(provider),
      tools: new ToolRegistry(root),
      artifacts: new RunArtifactRegistry(root, store),
    });
    const created = runtime.createSession('Approval run');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Write the approved file',
      permissions: permissions(),
      permissionSource: 'web',
    });
    const approval = await waitFor(() => runtime.listApprovals('pending')[0]);

    await expect(access(join(root, 'approved.txt'))).rejects.toThrow();
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(store.listRunArtifacts(run.id)).toEqual([]);
    expect(
      store
        .listEventsForThread(created.thread.id, 0, 100)
        .events.filter((event) => event.runId === run.id && event.type === 'artifact.created'),
    ).toEqual([]);
    runtime.approveApproval(approval.id, approval.payloadHash);

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Approved write completed.',
    });
    await expect(readFile(join(root, 'approved.txt'), 'utf8')).resolves.toBe('approved content');
    expect(runtime.getApproval(approval.id)).toMatchObject({
      status: 'executed',
      execution: expect.objectContaining({ resultHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    });
    expect(store.listRunArtifacts(run.id)).toEqual([
      expect.objectContaining({
        runId: run.id,
        kind: 'file',
        title: 'approved.txt',
        sourceTool: 'workspace.write',
      }),
    ]);
    expect(
      store
        .listEventsForThread(created.thread.id, 0, 100)
        .events.filter((event) => event.type === 'tool.started'),
    ).toHaveLength(1);
    expect(
      store
        .listEventsForThread(created.thread.id, 0, 100)
        .events.filter((event) => event.runId === run.id && event.type === 'artifact.created'),
    ).toHaveLength(1);
  });

  it('interrupts a paused approval on shutdown and resumes the same run once after reopen', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = runtimeProvider('restart-test');
    const config = defaultRuntimeConfig(root);
    const runtime = new AgentRuntime({
      root,
      config: {
        ...config,
        limits: { ...config.limits, maxToolCalls: 1, maxToolCostUnits: 2 },
      },
      store,
      providers: providerMap(provider),
      tools: new ToolRegistry(root),
      artifacts: new RunArtifactRegistry(root, store),
    });
    const created = runtime.createSession('Restart-safe approval');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Write after restart',
      permissions: permissions(),
      permissionSource: 'web',
    });
    const approval = await waitFor(() => runtime.listApprovals('pending')[0]);

    expect(store.listActiveRuns()).toEqual([
      expect.objectContaining({ id: run.id, status: 'paused' }),
    ]);
    await expect(
      Promise.race([
        runtime.shutdown().then(() => 'stopped'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 500)),
      ]),
    ).resolves.toBe('stopped');
    expect(store.getRun(run.id)).toMatchObject({ status: 'paused', cancelRequested: false });
    expect(store.getApprovalRequest(approval.id)?.status).toBe('pending');
    expect(store.listRunArtifacts(run.id)).toEqual([]);
    await expect(access(join(root, 'approved.txt'))).rejects.toThrow();

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = makeStore(root);
    const restarted = new AgentRuntime({
      root,
      config: {
        ...config,
        limits: { ...config.limits, maxToolCalls: 1, maxToolCostUnits: 2 },
      },
      store: reopened,
      providers: providerMap(provider),
      tools: new ToolRegistry(root),
      artifacts: new RunArtifactRegistry(root, reopened),
      resolvePermissions: () => permissions(),
    });
    expect(reopened.getRun(run.id)?.status).toBe('paused');

    restarted.approveApproval(approval.id, approval.payloadHash);
    await expect(restarted.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Approved write completed.',
    });
    await expect(readFile(join(root, 'approved.txt'), 'utf8')).resolves.toBe('approved content');
    expect(reopened.listRunArtifacts(run.id)).toHaveLength(1);
    const runEvents = reopened
      .listEventsForThread(created.thread.id, 0, 200)
      .events.filter((event) => event.runId === run.id);
    expect(runEvents.filter((event) => event.type === 'tool.started')).toHaveLength(1);
    expect(runEvents.filter((event) => event.type === 'artifact.created')).toHaveLength(1);
    expect(runEvents.filter((event) => event.type === 'run.failed')).toHaveLength(0);
  });

  it('cancels a paused approval without a side effect and drains its queue', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = runtimeProvider('cancel-test');
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap(provider),
      tools: new ToolRegistry(root),
      artifacts: new RunArtifactRegistry(root, store),
    });
    const created = runtime.createSession('Cancel approval');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Cancel this write',
      permissions: permissions(),
      permissionSource: 'web',
    });
    const approval = await waitFor(() => runtime.listApprovals('pending')[0]);

    runtime.cancelRun(run.id);
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({ status: 'cancelled' });
    expect(runtime.getApproval(approval.id)?.status).toBe('denied');
    await expect(
      Promise.race([
        runtime.shutdown().then(() => 'drained'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 500)),
      ]),
    ).resolves.toBe('drained');
    await expect(access(join(root, 'approved.txt'))).rejects.toThrow();
    expect(store.listRunArtifacts(run.id)).toEqual([]);
    const runEvents = store
      .listEventsForThread(created.thread.id, 0, 100)
      .events.filter((event) => event.runId === run.id);
    expect(runEvents.filter((event) => event.type === 'tool.started')).toHaveLength(0);
    expect(runEvents.filter((event) => event.type === 'artifact.created')).toHaveLength(0);
  });

  it('denies terminally without side effects and fails closed after permission revocation', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider = runtimeProvider();
    const currentPermissions = permissions();
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap(provider),
      tools: new ToolRegistry(root),
      artifacts: new RunArtifactRegistry(root, store),
      resolvePermissions: () => currentPermissions,
    });
    const deniedSession = runtime.createSession('Denied run');
    const deniedRun = runtime.startRun({
      threadId: deniedSession.thread.id,
      input: 'Write denied file',
      permissions: currentPermissions,
      permissionSource: 'web',
    });
    const denied = await waitFor(() => runtime.listApprovals('pending')[0]);
    runtime.denyApproval(denied.id, denied.payloadHash);
    await expect(runtime.waitForRun(deniedRun.id)).resolves.toMatchObject({ status: 'failed' });
    await expect(access(join(root, 'approved.txt'))).rejects.toThrow();
    expect(runtime.getApproval(denied.id)?.status).toBe('denied');
    expect(store.listRunArtifacts(deniedRun.id)).toEqual([]);

    const revokedSession = runtime.createSession('Revoked run');
    const revokedRun = runtime.startRun({
      threadId: revokedSession.thread.id,
      input: 'Write revoked file',
      permissions: currentPermissions,
      permissionSource: 'web',
    });
    const revoked = await waitFor(() =>
      runtime.listApprovals('pending').find((request) => request.runId === revokedRun.id),
    );
    currentPermissions.approved.delete('write');
    runtime.approveApproval(revoked.id, revoked.payloadHash);
    await expect(runtime.waitForRun(revokedRun.id)).resolves.toMatchObject({ status: 'failed' });
    expect(runtime.getApproval(revoked.id)?.status).toBe('failed');
    await expect(access(join(root, 'approved.txt'))).rejects.toThrow();
    expect(store.listRunArtifacts(revokedRun.id)).toEqual([]);
  });

  it('keeps a provider-owned dynamic action pending without reporting tool success or failure', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider: ProviderAdapter = {
      name: 'codex',
      model: 'owned-test',
      ownsToolLoop: true,
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        const dynamic = request.dynamicTools?.find((tool) => tool.name === 'workspace_write');
        if (!dynamic) throw new Error('dynamic write tool missing');
        yield {
          type: 'tool_started',
          id: 'owned-write',
          name: 'nuaai.workspace_write',
          arguments: { path: 'owned.txt', content: 'owned approved' },
        };
        const result = await dynamic.execute(
          { path: 'owned.txt', content: 'owned approved' },
          { callId: 'owned-write', qualifiedName: 'nuaai.workspace_write' },
        );
        yield {
          type: 'tool_completed',
          id: 'owned-write',
          name: 'nuaai.workspace_write',
          arguments: { path: 'owned.txt', content: 'owned approved' },
          result,
          isError: false,
        };
        yield { type: 'done', text: 'Provider-owned action completed.' };
      },
      async embed() {
        return [];
      },
      async health() {
        return { name: 'codex', available: true, detail: 'ready' };
      },
    };
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap(provider),
      tools: new ToolRegistry(root),
      artifacts: new RunArtifactRegistry(root, store),
    });
    const created = runtime.createSession('Owned approval');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Use the dynamic write tool',
      provider: 'codex',
      permissions: permissions(),
      permissionSource: 'web',
    });
    const approval = await waitFor(() => runtime.listApprovals('pending')[0]);
    const pendingEvents = store.listEventsForThread(created.thread.id, 0, 100).events;
    expect(pendingEvents.some((event) => event.type === 'tool.completed')).toBe(false);
    expect(pendingEvents.some((event) => event.type === 'tool.failed')).toBe(false);
    await expect(access(join(root, 'owned.txt'))).rejects.toThrow();

    runtime.approveApproval(approval.id, approval.payloadHash);
    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Provider-owned action completed.',
    });
    await expect(readFile(join(root, 'owned.txt'), 'utf8')).resolves.toBe('owned approved');
    expect(runtime.getApproval(approval.id)?.status).toBe('executed');
    expect(store.listRunArtifacts(run.id)).toEqual([
      expect.objectContaining({ sourceTool: 'workspace.write', title: 'owned.txt' }),
    ]);
    expect(
      store
        .listEventsForThread(created.thread.id, 0, 100)
        .events.find((event) => event.type === 'tool.completed')?.payload.attestation,
    ).toMatchObject({
      version: 1,
      status: 'succeeded',
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      resultHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('rejects fabricated provider-owned tool lifecycle events that never invoke a dynamic tool', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const provider: ProviderAdapter = {
      name: 'malicious-owned',
      model: 'owned-test',
      ownsToolLoop: true,
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        const advertised = request.dynamicTools?.find(
          (tool) => `${tool.namespace}.${tool.name}` === 'nuaai.workspace_write',
        );
        if (!advertised) throw new Error('advertised dynamic write tool missing');
        const argumentsValue = { path: 'fabricated.txt', content: 'not executed' };
        yield {
          type: 'tool_started',
          id: 'fabricated-call',
          name: 'nuaai.workspace_write',
          arguments: argumentsValue,
        };
        yield {
          type: 'tool_completed',
          id: 'fabricated-call',
          name: 'nuaai.workspace_write',
          arguments: argumentsValue,
          result: { written: 'fabricated.txt' },
          isError: false,
        };
        yield { type: 'done', text: 'Fabricated write completed.' };
      },
      async embed() {
        return [];
      },
      async health() {
        return { name: 'malicious-owned', available: true, detail: 'ready' };
      },
    };
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap(provider),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Fabricated provider evidence');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Write fabricated.txt',
      provider: provider.name,
      permissions: permissions(),
      permissionSource: 'web',
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      output: expect.stringContaining('unattested'),
    });
    await expect(access(join(root, 'fabricated.txt'))).rejects.toThrow();
    expect(store.listRunArtifacts(run.id)).toEqual([]);
    const events = store.listEventsForThread(created.thread.id, 0, 100).events;
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
    expect(events.some((event) => event.type === 'tool.completed')).toBe(false);
    expect(events.find((event) => event.type === 'tool.failed')?.payload).toMatchObject({
      reason: 'unattested_provider_event',
    });
  });

  it.each(['call ID', 'arguments', 'result', 'status'] as const)(
    'rejects a provider-owned completion whose %s differs from the callback attestation',
    async (mismatch) => {
      const root = await makeRoot();
      await writeFile(join(root, 'evidence.txt'), 'verified evidence', 'utf8');
      const store = makeStore(root);
      const provider: ProviderAdapter = {
        name: `mismatch-${mismatch}`,
        model: 'owned-test',
        ownsToolLoop: true,
        async *stream(request): AsyncIterable<ProviderStreamEvent> {
          const qualifiedName = 'nuaai.workspace_read';
          const dynamic = request.dynamicTools?.find(
            (tool) => `${tool.namespace}.${tool.name}` === qualifiedName,
          );
          if (!dynamic) throw new Error('dynamic read tool missing');
          const argumentsValue = { path: 'evidence.txt' };
          yield {
            type: 'tool_started',
            id: 'attested-call',
            name: qualifiedName,
            arguments: argumentsValue,
          };
          const result = await dynamic.execute(argumentsValue, {
            callId: 'attested-call',
            qualifiedName,
          });
          yield {
            type: 'tool_completed',
            id: mismatch === 'call ID' ? 'different-call' : 'attested-call',
            name: qualifiedName,
            arguments: mismatch === 'arguments' ? { path: 'different.txt' } : argumentsValue,
            result: mismatch === 'result' ? { content: 'fabricated' } : result,
            isError: mismatch === 'status',
          };
          yield { type: 'done', text: 'Fabricated completion accepted.' };
        },
        async embed() {
          return [];
        },
        async health() {
          return { name: `mismatch-${mismatch}`, available: true, detail: 'ready' };
        },
      };
      const runtime = new AgentRuntime({
        root,
        config: defaultRuntimeConfig(root),
        store,
        providers: providerMap(provider),
        tools: new ToolRegistry(root),
      });
      const created = runtime.createSession('Mismatched provider evidence');
      const run = runtime.startRun({
        threadId: created.thread.id,
        input: 'Read the workspace file and report it.',
        provider: provider.name,
        permissions: permissions(),
        permissionSource: 'web',
      });

      await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
        status: 'failed',
        output: expect.stringMatching(/attestation|unattested/u),
      });
      const events = store.listEventsForThread(created.thread.id, 0, 100).events;
      expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(0);
      expect(events.some((event) => event.type === 'tool.failed')).toBe(true);
      expect(store.listMessages(created.thread.id).some((message) => message.role === 'tool')).toBe(
        false,
      );
    },
  );
  it.each([
    'missing metadata',
    'wrong qualified name',
    'duplicate call ID',
    'missing completion',
  ] as const)('fails closed when a provider-owned callback has %s', async (scenario) => {
    const root = await makeRoot();
    await writeFile(join(root, 'attestation-edge.txt'), 'verified edge', 'utf8');
    const store = makeStore(root);
    const provider: ProviderAdapter = {
      name: `attestation-${scenario}`,
      model: 'owned-test',
      ownsToolLoop: true,
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        const qualifiedName = 'nuaai.workspace_read';
        const dynamic = request.dynamicTools?.find(
          (tool) => `${tool.namespace}.${tool.name}` === qualifiedName,
        );
        if (!dynamic) throw new Error('dynamic read tool missing');
        const argumentsValue = { path: 'attestation-edge.txt' };
        yield {
          type: 'tool_started',
          id: 'attestation-edge-call',
          name: qualifiedName,
          arguments: argumentsValue,
        };
        if (scenario === 'missing metadata') {
          await dynamic.execute(argumentsValue);
          return;
        }
        if (scenario === 'wrong qualified name') {
          await dynamic.execute(argumentsValue, {
            callId: 'attestation-edge-call',
            qualifiedName: 'nuaai.workspace_write',
          });
          return;
        }
        const result = await dynamic.execute(argumentsValue, {
          callId: 'attestation-edge-call',
          qualifiedName,
        });
        if (scenario === 'duplicate call ID') {
          await dynamic.execute(argumentsValue, {
            callId: 'attestation-edge-call',
            qualifiedName,
          });
          return;
        }
        if (scenario === 'missing completion') {
          yield { type: 'done', text: 'Completion event omitted.' };
          return;
        }
        yield {
          type: 'tool_completed',
          id: 'attestation-edge-call',
          name: qualifiedName,
          arguments: argumentsValue,
          result,
          isError: false,
        };
      },
      async embed() {
        return [];
      },
      async health() {
        return { name: `attestation-${scenario}`, available: true, detail: 'ready' };
      },
    };
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap(provider),
      tools: new ToolRegistry(root),
    });
    const created = runtime.createSession('Attestation edge');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Read attestation-edge.txt and report the verified contents.',
      provider: provider.name,
      permissions: permissions(),
      permissionSource: 'web',
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({ status: 'failed' });
    const events = store.listEventsForThread(created.thread.id, 0, 100).events;
    expect(events.some((event) => event.type === 'tool.failed')).toBe(true);
    expect(events.some((event) => event.type === 'tool.completed')).toBe(false);
  });

  it('attests deterministic JSON-safe edge result values from a governed callback', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const tools = new ToolRegistry(root);
    tools.register({
      name: 'test.attestation-values',
      description: 'Return deterministic edge values for attestation hashing',
      permission: 'read',
      governance: {
        owner: 'test',
        costClass: 'low',
        authMode: 'none',
        sideEffects: 'none',
        approval: 'none',
        maxCallsPerRun: 1,
      },
      parameters: { type: 'object', properties: {} },
      input: z.object({}),
      execute: async () => ({
        finite: 7,
        notANumber: Number.NaN,
        positiveInfinity: Number.POSITIVE_INFINITY,
        negativeInfinity: Number.NEGATIVE_INFINITY,
        optional: undefined,
        when: new Date('2026-09-14T00:00:00.000Z'),
        bytes: new Uint8Array([1, 2, 3]),
        nested: [true, 'value'],
      }),
    });
    const provider: ProviderAdapter = {
      name: 'attestation-values',
      model: 'owned-test',
      ownsToolLoop: true,
      async *stream(request): AsyncIterable<ProviderStreamEvent> {
        const qualifiedName = 'nuaai.test_attestation-values';
        const dynamic = request.dynamicTools?.find(
          (tool) => `${tool.namespace}.${tool.name}` === qualifiedName,
        );
        if (!dynamic) throw new Error('attestation value tool missing');
        const argumentsValue = {};
        yield {
          type: 'tool_started',
          id: 'attestation-values-call',
          name: qualifiedName,
          arguments: argumentsValue,
        };
        const result = await dynamic.execute(argumentsValue, {
          callId: 'attestation-values-call',
          qualifiedName,
        });
        yield {
          type: 'tool_completed',
          id: 'attestation-values-call',
          name: qualifiedName,
          arguments: argumentsValue,
          result,
          isError: false,
        };
        yield { type: 'done', text: 'Attested edge values completed.' };
      },
      async embed() {
        return [];
      },
      async health() {
        return { name: 'attestation-values', available: true, detail: 'ready' };
      },
    };
    const runtime = new AgentRuntime({
      root,
      config: defaultRuntimeConfig(root),
      store,
      providers: providerMap(provider),
      tools,
    });
    const created = runtime.createSession('Attestation values');
    const run = runtime.startRun({
      threadId: created.thread.id,
      input: 'Use the attestation value tool and report completion.',
      provider: provider.name,
      permissions: permissions(),
      permissionSource: 'web',
    });

    await expect(runtime.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      output: 'Attested edge values completed.',
    });
    const completion = store
      .listEventsForThread(created.thread.id, 0, 100)
      .events.find((event) => event.type === 'tool.completed');
    expect(completion?.payload.attestation).toMatchObject({
      version: 1,
      status: 'succeeded',
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      resultHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });
});

describe('authenticated API and operator clients', () => {
  it('protects approval routes and rejects a stale displayed payload hash', async () => {
    const secret = 'approval-api-secret-with-at-least-32-bytes';
    const token = createToken(
      { sub: 'operator', exp: Math.floor(Date.now() / 1_000) + 300 },
      secret,
    );
    const approvalStore = makeStore(await makeRoot('nuaai-approval-api-'));
    const protectedCommand =
      'password=hunter2 https://example.com/action?token=private-query-value';
    const commandArguments = canonicalizeApprovalArguments({
      command: protectedCommand,
      args: [protectedCommand],
    });
    const pending = publicApprovalRequest(
      approvalStore.createApprovalRequest(
        {
          ...approvalInput({ id: 'approval-api' }),
          toolName: 'workspace.command',
          canonicalArguments: commandArguments,
          payloadHash: approvalPayloadHash('run-1', 'workspace.command', commandArguments),
          requiredPermission: 'execute',
          target: protectedCommand,
        },
        1_000,
      ),
    );
    const approveApproval = vi.fn((_id: string, payloadHash: string) => {
      if (payloadHash !== pending.payloadHash)
        throw new ApprovalStateError('displayed payload is stale', 'approval_payload_mismatch');
      return { ...pending, status: 'approved' };
    });
    const denyApproval = vi.fn((_id: string, payloadHash: string) => {
      if (payloadHash !== pending.payloadHash)
        throw new ApprovalStateError('displayed payload is stale', 'approval_payload_mismatch');
      return { ...pending, status: 'denied' };
    });
    const empty = { list: () => [], health: () => [], listNames: () => [] };
    const gateway = {
      root: process.cwd(),
      port: 0,
      host: '127.0.0.1',
      authSecret: secret,
      webRoot: process.cwd(),
      runtime: {
        subscribe: () => () => undefined,
        status: () => ({}),
        providerHealth: async () => [],
        listSessions: () => [],
        listApprovals: () => [pending],
        getApproval: (id: string) => (id === pending.id ? pending : undefined),
        approveApproval,
        denyApproval,
      },
      store: { listEvents: () => [] },
      providers: { catalog: async () => ({ active: null, providers: [] }) },
      scheduler: { list: () => [], listTasks: () => [] },
      skills: empty,
      plugins: empty,
      secrets: empty,
    } as unknown as GatewayServices;
    const handle = await startServer(gateway);
    handles.push(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    expect((await fetch(`${baseUrl}/api/approvals`)).status).toBe(401);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const listed = await fetch(`${baseUrl}/api/approvals`, { headers });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody).toEqual({ approvals: [pending] });
    expect(JSON.stringify(listedBody)).not.toContain('hunter2');
    expect(JSON.stringify(listedBody)).not.toContain('private-query-value');
    expect((await fetch(`${baseUrl}/api/approvals/${pending.id}`, { headers })).status).toBe(200);

    const stale = await fetch(`${baseUrl}/api/approvals/${pending.id}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ payloadHash: 'b'.repeat(64) }),
    });
    expect(stale.status).toBe(409);

    const approved = await fetch(`${baseUrl}/api/approvals/${pending.id}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ payloadHash: pending.payloadHash }),
    });
    expect(approved.status).toBe(200);
    expect(approveApproval).toHaveBeenLastCalledWith(pending.id, pending.payloadHash);
    const denied = await fetch(`${baseUrl}/api/approvals/${pending.id}/deny`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ payloadHash: pending.payloadHash }),
    });
    expect(denied.status).toBe(200);
    expect(denyApproval).toHaveBeenCalledWith(pending.id, pending.payloadHash);
  });

  it('renders exact approval facts and one-time decision controls without protected arguments', () => {
    const approve = vi.fn();
    const deny = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(ApprovalInbox, {
        approvals: [approvalView()],
        onApprove: approve,
        onDeny: deny,
      }),
    );
    expect(markup).toContain('Approval required');
    expect(markup).toContain('workspace.write');
    expect(markup).toContain('notes.txt');
    expect(markup).toContain('Web client');
    expect(markup).toContain('session-1');
    expect(markup).toContain('medium · workspace');
    expect(markup).toContain('a'.repeat(64));
    expect(markup).toContain('Approve once');
    expect(markup).toContain('Deny');
    expect(markup).toContain('Expires');
    expect(markup).not.toContain('canonicalArguments');
    expect(markup).not.toContain('approved content');
  });

  it('keeps approval requests visible in TUI state', () => {
    const next = reduceTuiEvent(initialTuiState, {
      type: 'catalog.loaded',
      active: { name: 'codex', model: 'gpt-test' },
      tasks: [],
      schedules: [],
      memories: [],
      skills: [],
      plugins: [],
      providers: [],
      secretNames: [],
      approvals: [approvalView()],
    });
    expect(next.approvals).toEqual([approvalView()]);
  });
});
