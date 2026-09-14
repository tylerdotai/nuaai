import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { harnessConfig, workspaceDirectory } from '../src/config/index.js';
import { runAgent } from '../src/core/agent.js';
import { createProvider, isProviderName } from '../src/core/provider.js';
import { createToken, validateToken } from '../src/gateway/token.js';
import { addMemory, listMemories, openMemoryDatabase } from '../src/memory/db.js';
import { cosineSimilarity, loadVectorExtension, searchVectors } from '../src/memory/vector.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { compileSkill, generateSkillSource } from '../src/skills/synthesizer.js';
import { getVersion, readPackageMetadata } from '../src/version.js';
import {
  initWorkspace,
  isProtectedWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  runWorkspaceCommand,
  safePath,
  textDiff,
  writeWorkspaceFile,
} from '../src/workspace/fs.js';

describe('NUAAI foundation', () => {
  it('exposes product metadata and package version', () => {
    expect(harnessConfig.name).toBe('NUAAI');
    expect(harnessConfig.tagline).toBe('not ur avg ai');
    expect(workspaceDirectory('/tmp/project')).toBe('/tmp/project/.nuaai');
    expect(readPackageMetadata().name).toBe('nuaai');
    expect(getVersion()).toBe('1.0.1');
  });

  it('runs observe, plan, and act in order', async () => {
    const calls: string[] = [];
    const result = await runAgent('hello', {
      async observe(input) {
        calls.push(`observe:${input}`);
        return { input };
      },
      async plan(observation) {
        calls.push(`plan:${observation.input}`);
        return { action: observation.input.toUpperCase() };
      },
      async act(action) {
        calls.push(`act:${action.action}`);
        return 'done';
      },
    });

    expect(result.result).toBe('done');
    expect(calls).toEqual(['observe:hello', 'plan:hello', 'act:HELLO']);
  });

  it('validates provider names and models', async () => {
    expect(isProviderName('ollama')).toBe(true);
    expect(isProviderName('unknown')).toBe(false);
    const provider = createProvider('ollama', 'llama3', async (prompt) => `reply:${prompt}`);
    expect(await provider.generateText('hi')).toBe('reply:hi');
    expect(() => createProvider('unknown', 'model', async () => '')).toThrow(
      'Unsupported provider',
    );
    expect(() => createProvider('ollama', ' ', async () => '')).toThrow('model is required');
  });

  it('creates and rejects signed gateway tokens', () => {
    const token = createToken({ sub: 'tester', exp: 2_000 }, 'secret', 1_000_000);
    expect(validateToken(token, 'secret', 1_500)).toMatchObject({ sub: 'tester', exp: 2_000 });
    expect(validateToken(token, 'wrong', 1_500)).toBeNull();
    expect(validateToken(`${token}x`, 'secret', 1_500)).toBeNull();
    expect(validateToken('malformed', 'secret', 1_500)).toBeNull();
    expect(validateToken('', 'secret', 1_500)).toBeNull();
    expect(validateToken(token, '', 1_500)).toBeNull();
    expect(
      validateToken(createToken({ sub: 'tester', exp: 1 }, 'secret'), 'secret', 2_000),
    ).toBeNull();
    expect(() => createToken({ sub: 'tester', exp: 2_000 }, '', 1_000)).toThrow(
      'secret is required',
    );
  });

  it('stores local memories in the .nuaai database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-db-'));
    const db = openMemoryDatabase(root);
    loadVectorExtension(db);
    expect(db.prepare('SELECT vec_version() AS version').get()).toMatchObject({
      version: expect.any(String),
    });
    expect(() => addMemory(db, '  ')).toThrow('content is required');
    expect(addMemory(db, 'first', 123)).toBe(1);
    expect(listMemories(db)).toEqual([{ id: 1, content: 'first', createdAt: 123 }]);
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('searches vectors by cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 0])).toThrow('dimensions');
    const matches = searchVectors(
      [1, 0],
      [
        { id: 'low', vector: [0, 1], value: 'low' },
        { id: 'high', vector: [1, 0], value: 'high' },
      ],
      1,
    );
    expect(matches).toEqual([{ id: 'high', vector: [1, 0], value: 'high', score: 1 }]);
    expect(searchVectors([1], [], 0)).toEqual([]);
  });

  it('registers, validates, and dispatches skills', async () => {
    const registry = new SkillRegistry();
    registry.register({
      name: 'echo',
      description: 'Echo text',
      input: z.string(),
      execute: (input) => `echo:${input}`,
    });
    registry.register({
      name: 'add',
      description: 'Add numbers',
      input: z.number(),
      execute: async (input) => Number(input) + 1,
    });
    expect(registry.list().map((skill) => skill.name)).toEqual(['add', 'echo']);
    expect(await registry.dispatch('echo', 'hi')).toBe('echo:hi');
    expect(await registry.dispatch('add', 2)).toBe(3);
    await expect(registry.dispatch('missing', null)).rejects.toThrow('Unknown skill');
    await expect(registry.dispatch('echo', 2)).rejects.toThrow();
    expect(() =>
      registry.register({
        name: 'echo',
        description: 'Duplicate',
        input: z.string(),
        execute: (input) => input,
      }),
    ).toThrow('already registered');
    expect(() =>
      registry.register({
        name: '',
        description: 'Invalid',
        input: z.string(),
        execute: (input) => input,
      }),
    ).toThrow('name is required');
  });

  it('generates and compiles a skill module', async () => {
    const source = generateSkillSource('echo-skill', 'Echo input', 'return input;');
    expect(source).toContain('export async function execute');
    expect(await compileSkill(source)).toContain('async function execute');
    expect(() => generateSkillSource('Bad Name', 'x', 'return input;')).toThrow('lowercase');
    expect(() => generateSkillSource('valid', 'x', ' ')).toThrow('body is required');
    await expect(compileSkill('')).rejects.toThrow('source is required');
  });

  it('initializes and safely operates on a workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuaai-workspace-'));
    const directory = await initWorkspace(root);
    expect(directory).toBe(join(root, '.nuaai'));
    await expect(readWorkspaceFile(root, '.nuaai/config.json')).rejects.toThrow(
      'Protected workspace file',
    );
    await initWorkspace(root);
    await writeFile(join(directory, 'matrix.env'), 'ACCESS_TOKEN=secret');
    await writeFile(join(directory, 'secrets', 'master.key'), 'secret');
    await writeFile(join(directory, 'memory.db'), 'database');
    expect(await listWorkspaceFiles(root)).toEqual([]);
    expect(isProtectedWorkspaceFile('config.json')).toBe(true);
    expect(isProtectedWorkspaceFile('runtime.json')).toBe(true);
    expect(isProtectedWorkspaceFile('matrix.env')).toBe(true);
    expect(isProtectedWorkspaceFile('secrets/master.key')).toBe(true);
    expect(isProtectedWorkspaceFile('plugins/planted/index.mjs')).toBe(true);
    expect(isProtectedWorkspaceFile('skills/planted/manifest.json')).toBe(true);
    await expect(readWorkspaceFile(root, '.nuaai/matrix.env')).rejects.toThrow(
      'Protected workspace file',
    );
    await writeFile(join(directory, 'runtime.json'), '{"token":"do-not-read"}');
    await link(join(directory, 'runtime.json'), join(root, 'hard-linked-runtime.txt'));
    await expect(readWorkspaceFile(root, 'hard-linked-runtime.txt')).rejects.toThrow('hard-linked');
    await expect(writeWorkspaceFile(root, 'hard-linked-runtime.txt', 'changed')).rejects.toThrow(
      'hard-linked',
    );
    expect(await readFile(join(directory, 'runtime.json'), 'utf8')).toBe('{"token":"do-not-read"}');
    await symlink(join(directory, 'runtime.json'), join(directory, 'runtime-alias.txt'));
    await expect(readWorkspaceFile(root, '.nuaai/runtime-alias.txt')).rejects.toThrow(
      'Protected workspace file',
    );
    await writeWorkspaceFile(root, 'src/generated.ts', 'export const generated = true;\n');
    expect(await readFile(join(root, 'src/generated.ts'), 'utf8')).toBe(
      'export const generated = true;\n',
    );
    expect(await listWorkspaceFiles(root)).toContain('src/generated.ts');
    expect(await listWorkspaceFiles(root)).not.toContain('.nuaai/config.json');
    expect(() => safePath(directory, '../escape')).toThrow('escapes workspace');
    await expect(
      runWorkspaceCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], root),
    ).rejects.toThrow('Absolute command is not allowlisted');
    await expect(runWorkspaceCommand('./echo', ['hello'], root)).rejects.toThrow(
      'Command path is not allowlisted',
    );
    await expect(runWorkspaceCommand('echo', ['hello'], root)).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'hello',
    });
    for (const commandLine of ['uname -a', 'df -h', 'free -h']) {
      await expect(runWorkspaceCommand(commandLine, [], root)).resolves.toMatchObject({
        exitCode: 0,
      });
    }
    await writeFile(join(root, 'README.md'), 'inside workspace');
    await expect(runWorkspaceCommand('cat', ['README.md'], root)).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'inside workspace',
    });
    await expect(runWorkspaceCommand('cat', ['/etc/os-release'], root)).rejects.toThrow(
      'outside workspace',
    );
    await expect(runWorkspaceCommand('ls', ['/etc'], root)).rejects.toThrow(
      'Command is not allowlisted',
    );
    await writeFile(join(root, '.env'), 'NUAAI_PRIVATE_VALUE=do-not-read');
    await expect(runWorkspaceCommand('cat', ['.env'], root)).rejects.toThrow(
      'Protected project file',
    );
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), '[remote "origin"]');
    await expect(runWorkspaceCommand('cat', ['.git/config'], root)).rejects.toThrow(
      'Protected project file',
    );
    const previousSentinel = process.env.NUAAI_WORKSPACE_SENTINEL;
    process.env.NUAAI_WORKSPACE_SENTINEL = 'must-not-leak';
    try {
      const childEnvironment = await runWorkspaceCommand('env', [], root, {
        allowedCommands: new Set(['env']),
      });
      expect(childEnvironment.stdout).not.toContain('NUAAI_WORKSPACE_SENTINEL');
      await expect(
        runWorkspaceCommand('ps', ['eww', '-p', String(process.pid)], root),
      ).rejects.toThrow('Unsupported ps arguments');
      await expect(
        runWorkspaceCommand('ps', ['-p', String(process.pid)], root),
      ).resolves.toMatchObject({
        exitCode: 0,
      });
    } finally {
      if (previousSentinel === undefined) process.env.NUAAI_WORKSPACE_SENTINEL = undefined;
      else process.env.NUAAI_WORKSPACE_SENTINEL = previousSentinel;
    }
    await symlink(join(directory, 'runtime.json'), join(root, 'runtime-alias.txt'));
    await expect(runWorkspaceCommand('cat', ['runtime-alias.txt'], root)).rejects.toThrow(
      'Protected workspace file',
    );
    await expect(runWorkspaceCommand('date', ['--file=/etc/os-release'], root)).rejects.toThrow(
      'Indirect file options are not supported',
    );
    await expect(
      runWorkspaceCommand('date', ['--reference=/etc/os-release'], root),
    ).rejects.toThrow('Indirect file options are not supported');

    await mkdir(join(root, '-'));
    await expect(
      runWorkspaceCommand('cat', ['--', '-/../../../etc/os-release'], root),
    ).rejects.toThrow('outside workspace');
    for (const command of ['file', 'hostname', 'ls', 'lscpu', 'lsblk', 'lspci', 'lsusb'])
      await expect(runWorkspaceCommand(command, [], root)).rejects.toThrow(
        'Command is not allowlisted',
      );
    await expect(runWorkspaceCommand('date', ['--set=2030-01-01'], root)).rejects.toThrow(
      'Mutating command options are not supported',
    );

    await expect(runWorkspaceCommand("printf 'hello world'", [], root)).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'hello world',
    });
    await expect(runWorkspaceCommand('echo hello; pwd', [], root)).rejects.toThrow(
      'Shell operators are not supported',
    );
    await expect(runWorkspaceCommand('cat', ['.nuaai/runtime.json'], root)).rejects.toThrow(
      'Protected workspace file',
    );
    await expect(runWorkspaceCommand('python3', ['-c', 'print(1)'], root)).rejects.toThrow(
      'Command is not allowlisted',
    );
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'unchanged');
    await symlink(outside, join(root, 'linked-output.txt'));
    await expect(writeWorkspaceFile(root, 'linked-output.txt', 'changed')).rejects.toThrow(
      'symbolic link',
    );
    expect(await readFile(outside, 'utf8')).toBe('unchanged');
    const externalDirectory = await mkdtemp(join(tmpdir(), 'nuaai-external-'));
    await symlink(externalDirectory, join(root, 'linked-directory'));
    await expect(
      writeWorkspaceFile(root, 'linked-directory/nested/planted.txt', 'changed'),
    ).rejects.toThrow('escapes workspace');
    await expect(
      readFile(join(externalDirectory, 'nested/planted.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      writeWorkspaceFile(root, '.nuaai/plugins/planted/index.mjs', 'code'),
    ).rejects.toThrow('Protected workspace file');
    await expect(
      writeWorkspaceFile(root, '.nuaai/skills/planted/manifest.json', '{}'),
    ).rejects.toThrow('Protected workspace file');
    expect(textDiff('one\n', 'two\n').map((change) => change.value)).toEqual(['one\n', 'two\n']);
    await rm(externalDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
});
