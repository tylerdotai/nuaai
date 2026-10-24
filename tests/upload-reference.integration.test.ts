import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('delivers the upstream uploaded-file reference through the bounded attachment decoder to the actual provider request', async () => {
  const h = await identityHarness(undefined, (config) => {
    config.learning.mode = 'off';
  });
  try {
    const session = h.daemon.runtime.createSession(
      'Uploaded attachment',
      'upload-contract',
      undefined,
      { workspaceRoot: h.project },
    );
    const body = new FormData();
    body.append(
      'files',
      new File(['UPLOAD_REFERENCE_CONTENT'], 'notes.txt', { type: 'text/plain' }),
    );
    const response = await fetch(`http://127.0.0.1:${h.daemon.gateway.port}/api/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.daemon.token}` },
      body,
    });
    expect(response.status).toBe(200);
    const uploaded = await response.json();
    const run = await h.api('/api/runs', {
      threadId: session.thread.id,
      input: 'Describe this attachment; do not use tools.',
      attachments: uploaded.files,
    });
    expect(run.status).toBe(200);
    expect((await h.daemon.runtime.waitForRun(run.body.id)).status).toBe('completed');
    expect(JSON.stringify(h.observed.at(-1)?.messages)).toContain('UPLOAD_REFERENCE_CONTENT');
  } finally {
    await h.close();
  }
});

it('refuses an unregistered upload identifier instead of reading private runtime paths', async () => {
  const h = await identityHarness();
  try {
    const response = await fetch(
      `http://127.0.0.1:${h.daemon.gateway.port}/api/uploads/..%2Fconfig.json`,
      { headers: { authorization: `Bearer ${h.daemon.token}` } },
    );
    expect(response.status).toBe(404);
  } finally {
    await h.close();
  }
});
