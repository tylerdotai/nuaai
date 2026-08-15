import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';

const root = resolve(process.env.NUAAI_ROOT ?? resolve(import.meta.dirname, '..'));
const composeFile = resolve(root, 'deploy/local/docker-compose.yml');
const localRoot = resolve(root, 'deploy/local');
const synapseState = resolve(localRoot, 'state/synapse');
const runtimeRoot = resolve(root, '.nuaai');
const envFile = resolve(localRoot, '.env.integrations');
const matrixEnvFile = resolve(runtimeRoot, 'matrix.env');
const botPasswordFile = resolve(synapseState, '.nuaai-bot-password');

function runDocker(args, options = {}) {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', envFile, '-f', composeFile, ...args],
    {
      cwd: root,
      stdio: 'inherit',
      ...options,
    },
  );
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed`);
}

function chownSynapseState(uid, gid) {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      '0',
      '--entrypoint',
      '/bin/chown',
      '-v',
      `${synapseState}:/data`,
      'matrixdotorg/synapse:latest',
      '-R',
      `${uid}:${gid}`,
      '/data',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('Could not normalize Synapse state ownership');
}

function ensureSynapseOwnership() {
  chownSynapseState(String(process.getuid?.() ?? 1000), String(process.getgid?.() ?? 1000));
}

function ensureSynapseServiceOwnership() {
  chownSynapseState('991', '991');
}

async function portInUse(port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      resolvePort(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function portFromUrl(value) {
  try {
    const port = Number(new URL(value).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

async function choosePort(candidate, used) {
  if (
    Number.isInteger(candidate) &&
    candidate >= 40_000 &&
    candidate <= 60_000 &&
    !used.has(candidate) &&
    !(await portInUse(candidate))
  ) {
    used.add(candidate);
    return candidate;
  }
  let port = randomInt(40_000, 60_000);
  while (used.has(port) || (await portInUse(port))) port = randomInt(40_000, 60_000);
  used.add(port);
  return port;
}

async function ensureLocalPorts() {
  const configFile = resolve(runtimeRoot, 'config.json');
  let config = {};
  try {
    config = JSON.parse(await readFile(configFile, 'utf8'));
  } catch {
    // `nuaai init` may not have run yet; create the local map for the next start.
  }
  const used = new Set();
  const daemonPort = await choosePort(config.port, used);
  const synapsePort = await choosePort(portFromUrl(config.matrix?.homeserverUrl), used);
  const searxngPort = await choosePort(portFromUrl(config.search?.searxngUrl), used);
  const crawl4aiPort = await choosePort(portFromUrl(config.search?.crawl4aiUrl), used);
  const flaresolverrPort = await choosePort(portFromUrl(config.search?.flaresolverrUrl), used);

  config.port = daemonPort;
  config.search = {
    ...(config.search ?? {}),
    searxngUrl: `http://127.0.0.1:${searxngPort}`,
    crawl4aiUrl: `http://127.0.0.1:${crawl4aiPort}`,
    flaresolverrUrl: `http://127.0.0.1:${flaresolverrPort}`,
  };
  config.matrix = {
    ...(config.matrix ?? {}),
    homeserverUrl: `http://127.0.0.1:${synapsePort}`,
  };
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  return { daemonPort, synapsePort, searxngPort, crawl4aiPort, flaresolverrPort };
}

function stopLegacyContainer(name) {
  spawnSync('docker', ['stop', name], { cwd: root, stdio: 'ignore' });
}

function detectServerName() {
  try {
    const raw = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
    const dnsName = JSON.parse(raw).Self?.DNSName;
    if (typeof dnsName === 'string' && dnsName) return dnsName.replace(/\.$/, '');
  } catch {
    // Local-only fallback is useful on hosts without Tailscale.
  }
  return process.env.NUAAI_MATRIX_SERVER_NAME || 'localhost';
}

async function ensureSynapseConfig(serverName) {
  const configFile = resolve(synapseState, 'homeserver.yaml');
  ensureSynapseOwnership();
  try {
    await readFile(configFile, 'utf8');
  } catch {
    runDocker([
      'run',
      '--rm',
      '-e',
      `SYNAPSE_SERVER_NAME=${serverName}`,
      '-e',
      'SYNAPSE_REPORT_STATS=no',
      'synapse',
      'generate',
    ]);
    ensureSynapseOwnership();
  }
  let config = await readFile(configFile, 'utf8');
  if (!/^registration_shared_secret:/m.test(config))
    config += `\nregistration_shared_secret: "${randomBytes(32).toString('hex')}"\n`;
  config = config.replace(/^enable_registration:\s*.*$/m, 'enable_registration: true');
  if (!/^enable_registration:/m.test(config)) config += 'enable_registration: true\n';
  config = config.replace(
    /^enable_registration_without_verification:\s*.*$/m,
    'enable_registration_without_verification: true',
  );
  if (!/^enable_registration_without_verification:/m.test(config))
    config += 'enable_registration_without_verification: true\n';
  if (!/^public_baseurl:/m.test(config)) config += `public_baseurl: "https://${serverName}/"\n`;
  config = config.replace(/(^\s*- port:)\s*\d+/m, '$1 8008');
  await writeFile(configFile, config, { mode: 0o600 });
  ensureSynapseServiceOwnership();
}

async function ensureSearchSecret(ports) {
  let existing = '';
  try {
    existing = await readFile(envFile, 'utf8');
  } catch {
    // Generate the local environment file below.
  }
  const values = new Map(
    existing
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : ['', ''];
      })
      .filter(([key]) => key),
  );
  if (!values.get('SEARXNG_SECRET')) values.set('SEARXNG_SECRET', randomBytes(32).toString('hex'));
  values.set('NUAAI_SYNAPSE_PORT', String(ports.synapsePort));
  values.set('NUAAI_SEARXNG_PORT', String(ports.searxngPort));
  values.set('NUAAI_CRAWL4AI_PORT', String(ports.crawl4aiPort));
  values.set('NUAAI_FLARESOLVERR_PORT', String(ports.flaresolverrPort));
  await writeFile(
    envFile,
    `${[...values.entries()].map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
    { mode: 0o600 },
  );
  await chmod(envFile, 0o600);
}

async function waitForSynapse(synapsePort) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${synapsePort}/health`);
      if (response.ok) return;
    } catch {
      // Startup can take several seconds while Synapse initializes SQLite.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(`Synapse did not become healthy on http://127.0.0.1:${synapsePort}`);
}

async function ensureBotAccount(serverName, synapsePort) {
  ensureSynapseOwnership();
  try {
    await readFile(botPasswordFile, 'utf8');
  } catch {
    await writeFile(botPasswordFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  }
  await chmod(botPasswordFile, 0o600);
  ensureSynapseServiceOwnership();
  runDocker([
    'exec',
    '-T',
    'synapse',
    'register_new_matrix_user',
    '-c',
    '/data/homeserver.yaml',
    '-u',
    'nuaai',
    '--password-file',
    '/data/.nuaai-bot-password',
    '--no-admin',
    '--exists-ok',
    'http://localhost:8008',
  ]);

  ensureSynapseOwnership();
  const password = (await readFile(botPasswordFile, 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${synapsePort}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'nuaai' },
      password,
    }),
  });
  if (!response.ok) throw new Error(`Matrix bot login failed: ${response.status}`);
  const login = await response.json();
  if (typeof login.access_token !== 'string')
    throw new Error('Matrix bot login returned no access token');
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(
    matrixEnvFile,
    [
      `NUAAI_MATRIX_ACCESS_TOKEN=${login.access_token}`,
      `NUAAI_MATRIX_USER_ID=@nuaai:${serverName}`,
      `NUAAI_MATRIX_HOMESERVER_URL=http://127.0.0.1:${synapsePort}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await chmod(matrixEnvFile, 0o600);
}

async function enableDaemonMatrix(serverName, synapsePort) {
  const configFile = resolve(runtimeRoot, 'config.json');
  let config = {};
  try {
    config = JSON.parse(await readFile(configFile, 'utf8'));
  } catch {
    // `nuaai init` may not have run yet; the daemon will create the workspace first.
  }
  config.matrix = {
    ...(config.matrix ?? {}),
    enabled: true,
    homeserverUrl: `http://127.0.0.1:${synapsePort}`,
    userId: `@nuaai:${serverName}`,
  };
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

const serverName = detectServerName();
await mkdir(synapseState, { recursive: true });
const ports = await ensureLocalPorts();
await ensureSearchSecret(ports);
await ensureSynapseConfig(serverName);
stopLegacyContainer('crawl4ai');
stopLegacyContainer('flaresolverr');
const services = ['synapse', 'searxng', 'crawl4ai', 'flaresolverr'];
runDocker(['up', '-d', ...services]);
await waitForSynapse(ports.synapsePort);
await ensureBotAccount(serverName, ports.synapsePort);
await enableDaemonMatrix(serverName, ports.synapsePort);

process.stdout.write(
  `${[
    'Local integrations are running.',
    `Matrix server name: ${serverName}`,
    `Matrix bot: @nuaai:${serverName}`,
    'Matrix credentials: .nuaai/matrix.env (secret values not printed)',
    `NUAAI web UI: http://127.0.0.1:${ports.daemonPort}`,
    `Search services: loopback high ports ${ports.searxngPort}, ${ports.crawl4aiPort}, ${ports.flaresolverrPort}`,
  ].join('\n')}\n`,
);
