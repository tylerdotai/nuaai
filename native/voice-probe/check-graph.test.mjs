import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectGraph } from './check-graph.mjs';

const graph = [
  'nuaai-voice-probe v0.1.0 (/synthetic/probe)',
  ...['codex-api', 'codex-login', 'codex-model-provider', 'codex-http-client'].map(
    (name) => `${name} v0.164.0 (https://github.com/openai/codex?rev=6aaac694803004a63c6f393d153c96d22521a6b9#6aaac694)`,
  ),
].join('\n');

test('permits process/policy utilities but rejects every executor package', () => {
  assert.equal(inspectGraph(`${graph}\ncodex-execpolicy v0.164.0`), 6);
  for (const name of ['codex-core', 'codex-app-server', 'codex-exec', 'codex-mcp-server']) {
    assert.throws(() => inspectGraph(`${graph}\n${name} v0.164.0`), /Forbidden executor dependency/u);
  }
});

test('requires actual graph root and all pinned native dependencies', () => {
  assert.throws(() => inspectGraph(''), /Missing probe graph root/u);
  assert.throws(() => inspectGraph(graph.replace('codex-login', 'other')), /Missing pinned dependency: codex-login/u);
  assert.throws(() => inspectGraph(graph.replaceAll('6aaac694803004a63c6f393d153c96d22521a6b9', 'unreviewed')), /Missing pinned dependency/u);
});

test('deduplicates repeated cargo tree entries', () => {
  const dependency = graph.split('\n')[1];
  assert.equal(inspectGraph(`${graph}\n${dependency} (*)`), 5);
});
