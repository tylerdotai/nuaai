import { describe, expect, it } from 'vitest';

import { buildCapabilityManifest, classifyVerificationPolicy } from '../src/core/capabilities.js';
import { assembleSystemPrompt } from '../src/core/prompt.js';
import { SessionRunQueue } from '../src/core/queue.js';
import { selectProviderTools } from '../src/core/runtime.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import {
  type PermissionContext,
  permissionContextForProfile,
} from '../src/security/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';

const permissions: PermissionContext = {
  approved: new Set(['read', 'write', 'execute']),
  capabilities: { filesystem: true, subprocess: true, network: true },
};

const provider = {
  name: 'codex',
  model: 'gpt-test-model',
  ownsToolLoop: true,
} as ProviderAdapter;

describe('runtime core contracts', () => {
  it('serializes runs in one session lane and releases the writer after completion', async () => {
    const queue = new SessionRunQueue();
    const order: string[] = [];
    let release!: () => void;
    const first = queue.enqueue('thread-1', 'run-1', async () => {
      order.push('run-1:start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push('run-1:end');
      return 'one';
    });
    const second = queue.enqueue('thread-1', 'run-2', async () => {
      order.push('run-2:start');
      return 'two';
    });

    await Promise.resolve();
    expect(queue.activeRun('thread-1')).toBe('run-1');
    expect(queue.isWriter('thread-1', 'run-1')).toBe(true);
    expect(queue.queuedRuns('thread-1')).toBe(1);
    expect(queue.queuedRuns()).toBe(1);
    expect(order).toEqual(['run-1:start']);
    release();
    await expect(first).resolves.toBe('one');
    await expect(second).resolves.toBe('two');
    expect(order).toEqual(['run-1:start', 'run-1:end', 'run-2:start']);
    expect(queue.activeRun('thread-1')).toBeUndefined();
    expect(queue.queuedRuns('thread-1')).toBe(0);
    expect(queue.queuedRuns()).toBe(0);
  });

  it('continues a session lane after a rejected run', async () => {
    const queue = new SessionRunQueue();
    const first = queue.enqueue('thread-1', 'run-1', async () => {
      throw new Error('first failed');
    });
    const second = queue.enqueue('thread-1', 'run-2', async () => 'recovered');

    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('recovered');
    expect(queue.activeRun('thread-1')).toBeUndefined();
    expect(queue.queuedRuns()).toBe(0);
  });

  it('classifies verification by the evidence the request actually needs', () => {
    expect(classifyVerificationPolicy('What tools do you have?')).toBe('none');
    expect(classifyVerificationPolicy("What's the latest UFC score tonight?")).toBe(
      'current_information',
    );
    expect(classifyVerificationPolicy('Read the current package.json in the workspace.')).toBe(
      'workspace_state',
    );
    expect(classifyVerificationPolicy('Remember that Tyler prefers Luna.')).toBe('memory_mutation');
    expect(classifyVerificationPolicy('Tell me a joke about browsers.')).toBe('none');
  });

  it('maps read-only and operator profiles to independent capability sets', () => {
    const readOnly = permissionContextForProfile('read-only');
    const operator = permissionContextForProfile('operator');

    expect([...readOnly.approved]).toEqual(['read']);
    expect(readOnly.capabilities).toEqual({ filesystem: true, network: true });
    expect([...operator.approved]).toEqual(['read', 'write', 'execute']);
    expect(operator.capabilities).toEqual({
      filesystem: true,
      subprocess: true,
      network: true,
    });
    operator.approved.clear();
    expect([...permissionContextForProfile('operator').approved]).toEqual([
      'read',
      'write',
      'execute',
    ]);
  });

  it('keeps the permission-filtered provider toolset stable across ordinary requests', () => {
    const tools = [
      { name: 'schedule.list' },
      { name: 'schedule.create' },
      { name: 'task.list' },
      { name: 'agent.start' },
      { name: 'workspace.read' },
    ] as never;

    expect(selectProviderTools('Schedule a reminder', tools)).toEqual(tools);
    expect(selectProviderTools('https://example.test/jobs/123', tools)).toEqual(tools);
    expect(selectProviderTools('Do not use any tools. Just say hello.', tools)).toEqual([]);
  });

  it('builds one capability manifest for prompt and runtime consumers', () => {
    const tools = new ToolRegistry('/tmp/nuaai-test-root');
    const manifest = buildCapabilityManifest({
      provider,
      model: provider.model,
      root: '/tmp/nuaai-test-root',
      permissions,
      tools,
      dynamicTools: [
        {
          namespace: 'nuaai',
          name: 'web_search',
          description: 'Search the web',
          parameters: { type: 'object' },
          execute: async () => ({ ok: true }),
        },
      ],
    });

    expect(manifest.provider).toBe('codex');
    expect(manifest.ownsToolLoop).toBe(true);
    expect(manifest.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'workspace.read', source: 'nuaai' }),
      ]),
    );
    expect(manifest.dynamicTools).toEqual(['nuaai.web_search']);
  });

  it('assembles a layered prompt with the live capability manifest', () => {
    const manifest = buildCapabilityManifest({
      provider,
      model: provider.model,
      root: '/tmp/nuaai-test-root',
      permissions,
      tools: new ToolRegistry('/tmp/nuaai-test-root'),
      dynamicTools: [],
    });
    const prompt = assembleSystemPrompt({
      identity: '## SOUL.md\nBe direct.',
      projectContext: '## AGENTS.md\nUse strict TypeScript.',
      memory: '- Tyler prefers Luna.',
      skills: 'No skills are registered.',
      manifest,
    });

    expect(prompt.sections.map((section) => section.name)).toEqual([
      'identity',
      'runtime',
      'capabilities',
      'operating_rules',
      'skills',
      'project_context',
      'memory',
    ]);
    expect(prompt.systemPrompt).toContain('codex');
    expect(prompt.systemPrompt).toContain('provider-owned tool loop');
    expect(prompt.systemPrompt).toContain('Use only verified tool results');
  });
});
