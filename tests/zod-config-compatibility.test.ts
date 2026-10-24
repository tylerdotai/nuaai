import { expect, it } from 'vitest';
import { parseRuntimeConfig, runtimeConfigSchema } from '../src/config/index.js';
import { pluginManifestSchema } from '../src/plugins/manifest.js';

it('fully materializes nested runtime defaults when configuration sections are absent or empty', () => {
  for (const value of [
    {},
    { provider: { codex: {} }, mcp: { computer: {} }, permissions: {}, limits: {} },
  ]) {
    const config = runtimeConfigSchema.parse(value);
    expect(config).toMatchObject({
      provider: {
        name: 'ollama',
        model: 'qwen3.5:latest',
        selectedModels: {},
        codex: { executable: 'codex', timeoutMs: 900000 },
      },
      embedding: { model: 'nomic-embed-text:latest', baseUrl: 'http://127.0.0.1:11434' },
      search: { duckduckgoEnabled: true },
      web: { publicBasePath: '/' },
      matrix: { enabled: false, allowedUsers: [], allowedRooms: [], reactions: true },
      audio: { voiceEnabled: false, ttsEnabled: false, timeoutMs: 180000 },
      mcp: {
        enabled: false,
        servers: {},
        computer: { enabled: false, command: 'cua-driver', args: ['mcp'] },
      },
      agents: { enabled: false, commands: {}, timeoutMs: 300000 },
      features: { ollama: true, codex: true, telemetry: false },
      permissions: { web: 'operator', matrix: 'operator', scheduler: 'operator' },
      limits: { maxTurns: 48, maxToolCalls: 48, approvalTtlMs: 900000, maxContextTokens: 262144 },
    });
  }
});

it('preserves string-keyed provider, MCP environment and agent-command records with nested defaults', () => {
  const config = parseRuntimeConfig({
    provider: { selectedModels: { custom: ' model-a ' } },
    mcp: { servers: { fixture: { command: 'fixture-mcp', env: { FIXTURE_VALUE: 'kept' } } } },
    agents: { commands: { fixture: { command: 'fixture-agent' } } },
  });
  expect(config.provider.selectedModels.custom).toBe('model-a');
  expect(config.mcp.servers.fixture).toEqual({
    command: 'fixture-mcp',
    args: [],
    env: { FIXTURE_VALUE: 'kept' },
    permission: 'read',
  });
  expect(config.agents.commands.fixture).toEqual({
    command: 'fixture-agent',
    args: [],
    inheritEnv: [],
  });
  expect(() =>
    runtimeConfigSchema.parse({ provider: { selectedModels: { invalid: 42 } } }),
  ).toThrow();
  expect(() =>
    runtimeConfigSchema.parse({
      mcp: { servers: { fixture: { command: 'fixture', env: { invalid: 42 } } } },
    }),
  ).toThrow();
});

it('preserves plugin arbitrary configuration records while rejecting nonstring dependency versions', () => {
  const manifest = {
    name: 'fixture-plugin',
    version: '1.0.0',
    apiVersion: '1',
    config: { nested: { enabled: true }, value: 42 },
    dependencies: { fixture: '^1' },
  };
  expect(pluginManifestSchema.parse(manifest)).toMatchObject({
    ...manifest,
    trusted: false,
    entry: 'index.mjs',
    capabilities: [],
  });
  expect(() =>
    pluginManifestSchema.parse({ ...manifest, dependencies: { invalid: 42 } }),
  ).toThrow();
});
