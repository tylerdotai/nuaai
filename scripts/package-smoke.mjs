import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'nuaai-package-smoke-'));
const artifacts = await mkdtemp(join(scratch, 'artifacts-'));
const installRoot = await mkdtemp(join(scratch, 'install-'));
const workspace = await mkdtemp(join(scratch, 'workspace-'));
const packageVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10_000_000,
    ...options,
  });
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not reserve a smoke-test port');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Installed daemon exited before health check:\n${logs.value}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The installed daemon may still be opening its database and HTTP socket.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Installed daemon did not become healthy:\n${logs.value}`);
}

run('npm', ['run', 'build:release']);
const packOutput = run('npm', [
  'pack',
  '--ignore-scripts',
  '--json',
  '--pack-destination',
  artifacts,
]);
const jsonStart = packOutput.lastIndexOf('\n[');
const packed = JSON.parse(packOutput.slice(jsonStart >= 0 ? jsonStart + 1 : 0));
if (!Array.isArray(packed) || packed.length !== 1) throw new Error('npm pack returned no artifact');
const manifest = packed[0];
const packagedFiles = new Set((manifest.files ?? []).map((file) => file.path));
const skillDirectories = (await readdir(resolve(root, 'skills'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (skillDirectories.length !== 12)
  throw new Error(`Expected 12 first-party skills, found ${skillDirectories.length}`);
for (const required of [
  'dist/cli.js',
  'dist/daemon.js',
  'dist/web/index.html',
  'scripts/nuaai.mjs',
  'scripts/nuaai-server.mjs',
  ...skillDirectories.map((name) => `skills/${name}/SKILL.md`),
]) {
  if (!packagedFiles.has(required)) throw new Error(`Package artifact is missing ${required}`);
}
if (packagedFiles.has('scripts/user-dogfood.ts'))
  throw new Error('Package artifact includes host-specific dogfood tooling');
const tarball = resolve(artifacts, manifest.filename);
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', installRoot, tarball], {
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
});
const installedPackage = JSON.parse(
  await readFile(resolve(installRoot, 'node_modules/nuaai/package.json'), 'utf8'),
);
if (installedPackage.scripts?.['dogfood:live'])
  throw new Error('Installed package advertises unavailable host-specific dogfood tooling');
const bin = resolve(installRoot, 'node_modules/.bin/nuaai');
const version = run(bin, ['--version'], { cwd: workspace }).trim();
if (version !== packageVersion)
  throw new Error(`Installed CLI reported ${version || '<empty>'}; expected ${packageVersion}`);

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverEntry = resolve(installRoot, 'node_modules/nuaai/scripts/nuaai-server.mjs');
const child = spawn(process.execPath, [serverEntry], {
  cwd: workspace,
  env: { ...process.env, NUAAI_PORT: String(port), NUAAI_TEST_MODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = { value: '' };
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk) => {
    logs.value = `${logs.value}${String(chunk)}`.slice(-8_000);
  });
try {
  await waitForHealth(baseUrl, child, logs);
  const shell = await fetch(`${baseUrl}/`);
  if (!shell.ok || shell.headers.has('set-cookie'))
    throw new Error('Installed browser shell either failed or leaked an authentication cookie');
  const pairUrl = run(bin, ['pair', baseUrl], { cwd: workspace }).trim();
  const token = new URLSearchParams(new URL(pairUrl).hash.slice(1)).get('token');
  if (!token) throw new Error('Installed CLI did not generate a pairing token');
  const pairing = await fetch(`${baseUrl}/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = pairing.headers.get('set-cookie')?.split(';')[0];
  if (!pairing.ok || !cookie) throw new Error('Installed browser pairing failed');
  const skillsResponse = await fetch(`${baseUrl}/api/skills`, { headers: { cookie } });
  const skillsBody = await skillsResponse.json();
  const installedSkills = new Set((skillsBody.skills ?? []).map((skill) => skill.name));
  for (const name of skillDirectories)
    if (!installedSkills.has(name)) throw new Error(`Installed daemon did not load skill ${name}`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

process.stdout.write(`Package smoke passed: ${tarball}\n`);
