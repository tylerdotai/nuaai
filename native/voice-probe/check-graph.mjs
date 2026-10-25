import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const forbidden = new Set(['codex-core', 'codex-app-server', 'codex-exec', 'codex-mcp-server']);

export function inspectGraph(text) {
  const packages = new Set();
  for (const line of text.split('\n')) {
    const match = /^([a-zA-Z0-9_-]+) v\S+/u.exec(line);
    if (!match) continue;
    if (forbidden.has(match[1])) throw new Error(`Forbidden executor dependency: ${match[1]}`);
    packages.add(line.replace(/ \(\*\)$/u, ''));
  }
  if (!text.startsWith('nuaai-voice-probe v')) throw new Error('Missing probe graph root');
  for (const name of ['codex-api', 'codex-login', 'codex-model-provider', 'codex-http-client']) {
    if (!text.includes(`${name} v0.164.0 (https://github.com/openai/codex?rev=6aaac694803004a63c6f393d153c96d22521a6b9#`)) {
      throw new Error(`Missing pinned dependency: ${name}`);
    }
  }
  return packages.size;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const graph = execFileSync(
    'cargo',
    [
      '+1.99.1', 'tree', '--locked', '--manifest-path',
      fileURLToPath(new URL('./Cargo.toml', import.meta.url)),
      '--target', 'x86_64-unknown-linux-gnu', '--edges', 'normal,build',
      '--prefix', 'none', '--format', '{p}',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  );
  console.log(`Linux normal/build graph: ${inspectGraph(graph)} unique packages; no core/app-server/exec/mcp-server`);
}
