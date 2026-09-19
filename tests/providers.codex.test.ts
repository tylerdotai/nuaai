import { describe, expect, it, vi } from 'vitest';

const execaMock = vi.fn();

vi.mock('execa', () => ({
  execa: (...args: unknown[]) => execaMock(...args),
}));

const { CodexProvider } = await import('../src/providers/codex.js');

function makeProvider(
  overrides: Partial<ConstructorParameters<typeof CodexProvider>[0]> = {},
): InstanceType<typeof CodexProvider> {
  return new CodexProvider({
    model: 'gpt-test',
    workspaceRoot: '/tmp/nuaai-codex-test',
    timeoutMs: 1_000,
    ...overrides,
  });
}

describe('CodexProvider contract', () => {
  it('exposes the configured model and a stable provider name', () => {
    const provider = makeProvider({ model: 'gpt-5-codex' });
    expect(provider.name).toBe('codex');
    expect(provider.model).toBe('gpt-5-codex');
  });

  it('uses the configured executable path when provided', () => {
    const provider = makeProvider({
      executable: '/opt/codex/bin/codex',
      workspaceRoot: '/srv',
    });
    expect(provider.name).toBe('codex');
  });

  it('reports embeddings as unavailable for codex', async () => {
    const provider = makeProvider();
    await expect(provider.embed()).rejects.toThrow(/Codex does not provide embeddings/);
  });

  it('reports healthy when the codex executable returns version output', async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: 'codex 0.1.0', stderr: '' });

    const provider = makeProvider();
    await expect(provider.health()).resolves.toEqual({
      name: 'codex',
      available: true,
      detail: 'codex 0.1.0',
    });
    expect(execaMock).toHaveBeenCalledWith(
      'codex',
      ['--version'],
      expect.objectContaining({ reject: false, timeout: 10_000 }),
    );
  });

  it('reports unhealthy when the codex executable exits non-zero', async () => {
    execaMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not found' });

    const provider = makeProvider();
    await expect(provider.health()).resolves.toEqual({
      name: 'codex',
      available: false,
      detail: 'not found',
    });
  });

  it('reports unhealthy when the codex executable throws', async () => {
    execaMock.mockRejectedValue(new Error('spawn failed'));

    const provider = makeProvider();
    await expect(provider.health()).resolves.toEqual({
      name: 'codex',
      available: false,
      detail: 'spawn failed',
    });
  });
});
