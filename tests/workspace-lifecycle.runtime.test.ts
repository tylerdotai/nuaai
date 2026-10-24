import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { identityHarness } from './identity.harness.js';

it.each(['trash', 'edit', 'copy', 'move', 'mkdir'] as const)(
  'verifies native workspace %s by its actual postcondition, not an unrelated successful tool',
  async (operation) => {
    const h = await identityHarness();
    const path = operation === 'mkdir' ? 'folder' : 'source.txt';
    await writeFile(join(h.project, 'source.txt'), 'before');
    vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
      const results = request.messages.filter((m) => m.role === 'tool');
      const input =
        operation === 'edit'
          ? { path, oldText: 'before', newText: 'after' }
          : ['copy', 'move'].includes(operation)
            ? { path, destination: 'destination.txt' }
            : { path };
      if (!results.length)
        yield {
          type: 'tool_call',
          id: 'operation',
          name: `workspace.${operation}`,
          arguments: input,
        };
      else if (results.length === 1)
        yield {
          type: 'tool_call',
          id: 'readback',
          name: ['trash', 'mkdir'].includes(operation) ? 'workspace.stat' : 'workspace.read',
          arguments: { path: ['copy', 'move'].includes(operation) ? 'destination.txt' : path },
        };
      else if (operation === 'move' && results.length === 2)
        yield {
          type: 'tool_call',
          id: 'source-check',
          name: 'workspace.stat',
          arguments: { path },
        };
      else yield { type: 'done', text: `Requested ${operation} verified.` };
    });
    try {
      const session = h.daemon.runtime.createSession(
        'Filesystem lifecycle',
        `test:${operation}`,
        undefined,
        { workspaceRoot: h.project },
      );
      await h.api(`/api/sessions/${session.session.id}/permissions`, {
        mode: 'unguarded',
        confirmUnguarded: true,
      });
      const verb = {
        trash: 'Delete',
        edit: 'Edit',
        copy: 'Copy',
        move: 'Move',
        mkdir: 'Create workspace directory',
      }[operation];
      const accepted = await h.api('/api/runs', {
        threadId: session.thread.id,
        input: `${verb} ${path}${['copy', 'move'].includes(operation) ? ' to destination.txt' : ''}.`,
      });
      const result = await h.daemon.runtime.waitForRun(accepted.body.id);
      expect(result.status, result.output).toBe('completed');
      if (operation === 'edit') expect(await readFile(join(h.project, path), 'utf8')).toBe('after');
      if (['copy', 'move'].includes(operation))
        expect(await readFile(join(h.project, 'destination.txt'), 'utf8')).toBe('before');
    } finally {
      await h.close();
    }
  },
  10000,
);
