import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock, readFileQueue, readFileMock } = vi.hoisted(() => {
  const execaMock = vi.fn();
  const readFileQueue: Array<string | NodeJS.ErrnoException> = [];
  const readFileMock = vi.fn(async () => {
    const next = readFileQueue.shift();
    if (next instanceof Error) throw next;
    if (next !== undefined && readFileQueue.length === 0) readFileQueue.push(next);
    return next;
  });
  return { execaMock, readFileQueue, readFileMock };
});

vi.mock('execa', () => ({
  execa: (...args: unknown[]) => execaMock(...args),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: readFileMock };
});

const { CodexProvider } = await import('../src/providers/codex.js');

interface MockSubprocess {
  kill: (signal?: string) => boolean;
  then: <T>(onFulfilled: (value: unknown) => T) => Promise<T>;
  catch: <T>(onRejected: (error: unknown) => T) => Promise<T>;
  finally: (callback: () => void) => Promise<unknown>;
}

function makeMockSubprocess(
  result: { exitCode: number; stdout: string; stderr: string } | Error,
  resolveDelayMs = 0,
): MockSubprocess {
  const kill = vi.fn(() => true);
  const promise = new Promise<unknown>((resolve, reject) => {
    if (resolveDelayMs === 0) {
      result instanceof Error ? reject(result) : resolve(result);
    } else {
      setTimeout(
        () => (result instanceof Error ? reject(result) : resolve(result)),
        resolveDelayMs,
      );
    }
  });
  const wrapped = promise as unknown as MockSubprocess;
  wrapped.kill = kill;
  return wrapped;
}

async function collect(
  provider: InstanceType<typeof CodexProvider>,
  request: Parameters<InstanceType<typeof CodexProvider>['stream']>[0],
): Promise<Array<{ type: string; text?: string }>> {
  const events: Array<{ type: string; text?: string }> = [];
  for await (const event of provider.stream(request)) {
    if (event.type === 'delta' || event.type === 'done') {
      events.push({ type: event.type, text: event.text });
    } else {
      events.push({ type: event.type });
    }
  }
  return events;
}

describe('CodexProvider streaming', () => {
  const workspaceRoot = '/tmp/nuaai-codex-stream-test';

  beforeEach(() => {
    execaMock.mockReset();
    readFileMock.mockClear();
    readFileQueue.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits a single done event when the final message is on disk before the subprocess settles', async () => {
    readFileQueue.push('final codex reply');

    execaMock.mockReturnValue(makeMockSubprocess({ exitCode: 0, stdout: '', stderr: '' }, 50));

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    const events = await collect(provider, {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'final codex reply' },
      { type: 'done', text: 'final codex reply' },
    ]);
  });

  it('falls back to JSON stdout when the on-disk file is whitespace only', async () => {
    readFileQueue.push('   \n');

    execaMock.mockReturnValue(
      makeMockSubprocess({
        exitCode: 0,
        stdout: JSON.stringify({ message: 'parsed from stdout' }),
        stderr: '',
      }),
    );

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    const events = await collect(provider, {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'parsed from stdout' },
      { type: 'done', text: 'parsed from stdout' },
    ]);
  });

  it('concatenates streamed chunks from the JSON stdout when the file is empty', async () => {
    readFileQueue.push('');

    execaMock.mockReturnValue(
      makeMockSubprocess({
        exitCode: 0,
        stdout: [JSON.stringify({ message: 'first ' }), JSON.stringify({ message: 'chunk' })].join(
          '\n',
        ),
        stderr: '',
      }),
    );

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    const events = await collect(provider, {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'first chunk' },
      { type: 'done', text: 'first chunk' },
    ]);
  });

  it('skips JSON error records when parsing stdout', async () => {
    readFileQueue.push('');

    execaMock.mockReturnValue(
      makeMockSubprocess({
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: 'error', message: 'ignored' }),
          JSON.stringify({ message: 'real reply' }),
        ].join('\n'),
        stderr: '',
      }),
    );

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    const events = await collect(provider, {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'real reply' },
      { type: 'done', text: 'real reply' },
    ]);
  });

  it('skips non-JSON lines when parsing stdout', async () => {
    readFileQueue.push('');

    execaMock.mockReturnValue(
      makeMockSubprocess({
        exitCode: 0,
        stdout: ['not-json', JSON.stringify({ message: 'real reply' })].join('\n'),
        stderr: '',
      }),
    );

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    const events = await collect(provider, {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'real reply' },
      { type: 'done', text: 'real reply' },
    ]);
  });

  it('falls back to stdout when the stdout field is the literal reply', async () => {
    readFileQueue.push('');

    execaMock.mockReturnValue(
      makeMockSubprocess({
        exitCode: 0,
        stdout: JSON.stringify({ text: 'literal text reply' }),
        stderr: '',
      }),
    );

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    const events = await collect(provider, {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'literal text reply' },
      { type: 'done', text: 'literal text reply' },
    ]);
  });

  it('skips stdout records whose text field is not a string', async () => {
    readFileQueue.push('');

    execaMock.mockReturnValue(
      makeMockSubprocess({
        exitCode: 0,
        stdout: [
          JSON.stringify({ text: 1234 }),
          JSON.stringify({ content: 'reply from content field' }),
        ].join('\n'),
        stderr: '',
      }),
    );

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    const events = await collect(provider, {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'reply from content field' },
      { type: 'done', text: 'reply from content field' },
    ]);
  });

  it('returns no message when stdout records have no recognized text fields', async () => {
    readFileQueue.push('');

    execaMock.mockReturnValue(
      makeMockSubprocess({
        exitCode: 0,
        stdout: JSON.stringify({ unrelated: 'no text field' }),
        stderr: '',
      }),
    );

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    await expect(
      collect(provider, {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/no final message/);
  });

  it('throws when the subprocess exits non-zero and no final message is on disk', async () => {
    readFileQueue.push('');

    execaMock.mockReturnValue(
      makeMockSubprocess({ exitCode: 2, stdout: '', stderr: 'codex cli failed' }),
    );

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    await expect(
      collect(provider, {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/Codex exec failed/);
  });

  it('throws when the final message is empty after parsing stdout', async () => {
    readFileQueue.push('');

    execaMock.mockReturnValue(
      makeMockSubprocess({
        exitCode: 0,
        stdout: JSON.stringify({ type: 'error', message: 'only an error' }),
        stderr: '',
      }),
    );

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    await expect(
      collect(provider, {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/no final message/);
  });

  it('rethrows the subprocess error when the file never appears', async () => {
    readFileQueue.push('');

    execaMock.mockReturnValue(makeMockSubprocess(new Error('codex spawn failed')));

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 500,
    });

    await expect(
      collect(provider, {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/codex spawn failed/);
  });

  it('rejects non-ENOENT read errors when polling the output file', async () => {
    const eacces = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    eacces.code = 'EACCES';
    readFileQueue.push(eacces);

    execaMock.mockReturnValue(makeMockSubprocess({ exitCode: 0, stdout: '', stderr: '' }));

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    await expect(
      collect(provider, {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/EACCES/);
  });

  it('ignores ENOENT while polling for the output file and resumes on the next read', async () => {
    const enoent = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    readFileQueue.push(enoent);
    readFileQueue.push('eventual reply');

    execaMock.mockReturnValue(makeMockSubprocess({ exitCode: 0, stdout: '', stderr: '' }, 10));

    const provider = new CodexProvider({
      model: 'gpt-test',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    const events = await collect(provider, {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'eventual reply' },
      { type: 'done', text: 'eventual reply' },
    ]);
  });

  it('omits the --model flag when neither request nor provider has a model', async () => {
    readFileQueue.push('reply without model flag');

    execaMock.mockReturnValue(makeMockSubprocess({ exitCode: 0, stdout: '', stderr: '' }));

    const provider = new CodexProvider({
      model: '',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    const events = await collect(provider, {
      model: '',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'reply without model flag' },
      { type: 'done', text: 'reply without model flag' },
    ]);
    const calledArgs = (execaMock.mock.calls[0] as unknown[])[1] as string[];
    expect(calledArgs.includes('--model')).toBe(false);
  });

  it('passes the --model flag when the provider has a configured model', async () => {
    readFileQueue.push('reply with model');

    execaMock.mockReturnValue(makeMockSubprocess({ exitCode: 0, stdout: '', stderr: '' }));

    const provider = new CodexProvider({
      model: 'gpt-configured',
      workspaceRoot,
      timeoutMs: 1_000,
    });

    const events = await collect(provider, {
      model: 'gpt-configured',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'reply with model' },
      { type: 'done', text: 'reply with model' },
    ]);
    const calledArgs = (execaMock.mock.calls[0] as unknown[])[1] as string[];
    expect(calledArgs).toContain('--model');
    expect(calledArgs).toContain('gpt-configured');
  });
});

describe('CodexProvider contract', () => {
  const workspaceRoot = '/tmp/nuaai-codex-test';

  beforeEach(() => {
    execaMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the configured model and a stable provider name', () => {
    const provider = new CodexProvider({
      model: 'gpt-5-codex',
      workspaceRoot,
    });
    expect(provider.name).toBe('codex');
    expect(provider.model).toBe('gpt-5-codex');
  });

  it('uses the configured executable path when provided', () => {
    const provider = new CodexProvider({
      executable: '/opt/codex/bin/codex',
      workspaceRoot: '/srv',
      model: 'gpt-test',
    });
    expect(provider.name).toBe('codex');
  });

  it('reports embeddings as unavailable for codex', async () => {
    const provider = new CodexProvider({ workspaceRoot, model: 'gpt-test' });
    await expect(provider.embed()).rejects.toThrow(/Codex does not provide embeddings/);
  });

  it('reports healthy when the codex executable returns version output', async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: 'codex 0.1.0', stderr: '' });

    const provider = new CodexProvider({ workspaceRoot, model: 'gpt-test' });
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

    const provider = new CodexProvider({ workspaceRoot, model: 'gpt-test' });
    await expect(provider.health()).resolves.toEqual({
      name: 'codex',
      available: false,
      detail: 'not found',
    });
  });

  it('reports unhealthy when the codex executable throws', async () => {
    execaMock.mockRejectedValue(new Error('spawn failed'));

    const provider = new CodexProvider({ workspaceRoot, model: 'gpt-test' });
    await expect(provider.health()).resolves.toEqual({
      name: 'codex',
      available: false,
      detail: 'spawn failed',
    });
  });
});
