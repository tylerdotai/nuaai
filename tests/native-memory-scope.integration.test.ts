import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import type { ProviderRequest } from '../src/providers/types.js';
import { identityHarness } from './identity.harness.js';

it('keeps a native model-requested memory save workspace-scoped by default rather than leaking through the explicit memory tool', async () => {
  const h = await identityHarness();
  const requests: ProviderRequest[] = [];
  let saved = false;
  vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
    requests.push(request);
    if (!saved) {
      saved = true;
      yield {
        type: 'tool_call',
        id: 'explicit-save',
        name: 'memory.store',
        arguments: { content: 'This project prefers blue controls.', metadata: {} },
      };
    } else yield { type: 'done', text: 'Understood.' };
  });
  try {
    const first = h.daemon.runtime.createSession('Explicit save', 'scoped-save', undefined, {
      workspaceRoot: h.project,
    });
    h.daemon.runtime.setSessionApprovalPolicy(first.session.id, 'unguarded');
    const accepted = await h.api('/api/runs', {
      threadId: first.thread.id,
      input: 'Remember this project prefers blue controls.',
    });
    expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
    const record = h.daemon.store
      .searchMemoryRows()
      .find((memory) => memory.content === 'This project prefers blue controls.');
    expect(record?.metadata.knowledge).toMatchObject({
      origin: 'explicit',
      scope: 'workspace',
      workspaceRoot: h.project,
    });
    const outside = join(h.root, 'unrelated');
    await mkdir(outside);
    const next = h.daemon.runtime.createSession(
      'Unrelated project',
      'scoped-save-other',
      undefined,
      { workspaceRoot: outside },
    );
    const second = await h.api('/api/runs', {
      threadId: next.thread.id,
      input: 'Respond using any relevant controls color preference.',
    });
    await h.daemon.runtime.waitForRun(second.body.id);
    expect(requests.at(-1)?.systemPrompt).not.toContain('blue controls');
  } finally {
    await h.close();
  }
}, 15_000);
