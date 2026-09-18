import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type ToolDefinition, type ToolGovernance, ToolRegistry } from '../src/tools/registry.js';

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'nuaai-tool-discovery-'));
}

function definition(
  name: string,
  governance: ToolGovernance,
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `Description for ${name}`,
    permission: governance.sideEffects === 'external' ? 'execute' : 'read',
    governance,
    parameters: { type: 'object', properties: {} },
    input: z.object({}),
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

const readGovernance: ToolGovernance = {
  owner: 'discovery',
  costClass: 'low',
  authMode: 'none',
  sideEffects: 'none',
  approval: 'none',
  maxCallsPerRun: 4,
};

describe('tool discovery surface', () => {
  it('lists every registered tool with description, governance, parameters, and category', async () => {
    const root = await makeRoot();
    const registry = new ToolRegistry(root, undefined, {}, {});
    registry.register(definition('workspace.probe', readGovernance));
    registry.register(
      definition(
        'agent.probe',
        { ...readGovernance, sideEffects: 'external', approval: 'profile' },
        { permission: 'execute' },
      ),
    );

    const descriptions = registry.listTools();
    const probe = descriptions.find((entry) => entry.name === 'workspace.probe');
    const agent = descriptions.find((entry) => entry.name === 'agent.probe');

    expect(probe).toMatchObject({
      name: 'workspace.probe',
      description: 'Description for workspace.probe',
      permission: 'read',
      category: 'workspace',
      governance: readGovernance,
    });
    expect(agent).toMatchObject({
      name: 'agent.probe',
      permission: 'execute',
      category: 'agent',
    });
    expect(descriptions.some((entry) => entry.name === 'workspace.read')).toBe(true);
  });

  it('returns null for an unknown tool and the full description for a known one', async () => {
    const root = await makeRoot();
    const registry = new ToolRegistry(root, undefined, {}, {});
    registry.register(definition('workspace.known', readGovernance));

    expect(registry.getTool('workspace.known')).toMatchObject({
      name: 'workspace.known',
      category: 'workspace',
      governance: readGovernance,
    });
    expect(registry.getTool('does.not.exist')).toBeNull();
  });

  it('exposes the JSON schema for a tool and rejects unknown tools', async () => {
    const root = await makeRoot();
    const registry = new ToolRegistry(root, undefined, {}, {});
    registry.register(definition('memory.probe', readGovernance));

    const schema = registry.getToolSchema('memory.probe');
    expect(schema).toMatchObject({
      name: 'memory.probe',
      description: 'Description for memory.probe',
      parameters: { type: 'object', properties: {} },
    });
    expect(typeof (schema as { input: unknown }).input).toBe('string');
    expect(registry.getToolSchema('does.not.exist')).toBeNull();
  });

  it('rejects tools with duplicate, blank, or invalid governance', async () => {
    const root = await makeRoot();
    const registry = new ToolRegistry(root, undefined, {}, {});

    expect(() => registry.register(definition('dup', readGovernance))).not.toThrow();
    expect(() => registry.register(definition('dup', readGovernance))).toThrow(
      /Tool already registered/,
    );

    expect(() =>
      registry.register(definition('blank-owner', { ...readGovernance, owner: '   ' })),
    ).toThrow(/Tool owner is required/);

    expect(() =>
      registry.register(definition('not-integer', { ...readGovernance, maxCallsPerRun: 1.5 })),
    ).toThrow(/Tool maxCallsPerRun must be positive/);

    expect(() =>
      registry.register(definition('zero', { ...readGovernance, maxCallsPerRun: 0 })),
    ).toThrow(/Tool maxCallsPerRun must be positive/);
  });
});
