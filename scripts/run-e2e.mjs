import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const existingRoot = process.env.NUAAI_E2E_ROOT;
const temporaryRoot = existingRoot ? undefined : await mkdtemp(join(tmpdir(), 'nuaai-e2e-'));
const e2eRoot = existingRoot ?? temporaryRoot;

if (!e2eRoot) throw new Error('Unable to create an isolated E2E workspace');

const findAvailablePort = async () =>
  await new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPort(new Error('Unable to allocate an isolated E2E port'));
        return;
      }
      server.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
    });
  });
const e2ePort = process.env.NUAAI_E2E_PORT
  ? Number(process.env.NUAAI_E2E_PORT)
  : existingRoot
    ? 49_187
    : await findAvailablePort();

if (!existingRoot) {
  await mkdir(join(e2eRoot, '.nuaai'), { recursive: true });
  await writeFile(
    join(e2eRoot, '.nuaai', 'config.json'),
    JSON.stringify({
      version: 1,
      name: 'NUAAI',
      host: '127.0.0.1',
      port: e2ePort,
      provider: { name: 'deterministic', model: 'deterministic' },
      features: {
        ollama: false,
        codex: false,
        matrix: false,
        search: false,
        browser: false,
        telemetry: false,
      },
      mcp: {
        enabled: false,
        servers: {},
        computer: { enabled: false, command: 'cua-driver', args: ['mcp'] },
      },
    }),
  );
}

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const browserExecutable =
  process.env.NUAAI_PLAYWRIGHT_EXECUTABLE_PATH ??
  ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((path) => existsSync(path));
const child = spawn(command, ['playwright', 'test', ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NUAAI_E2E_ROOT: e2eRoot,
    NUAAI_E2E_PORT: String(e2ePort),
    ...(browserExecutable ? { NUAAI_PLAYWRIGHT_EXECUTABLE_PATH: browserExecutable } : {}),
  },
  stdio: 'inherit',
});

const exitCode = await new Promise((resolveExit) => {
  child.once('error', (error) => {
    console.error(error);
    resolveExit(1);
  });
  child.once('exit', (code, signal) => {
    resolveExit(code ?? (signal ? 1 : 0));
  });
});

if (temporaryRoot && process.platform === 'linux') {
  const trash = spawn('gio', ['trash', temporaryRoot], { stdio: 'ignore' });
  await new Promise((resolveTrash) => trash.once('exit', () => resolveTrash()));
}

process.exitCode = exitCode;
