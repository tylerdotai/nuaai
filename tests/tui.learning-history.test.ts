import { expect, it, vi } from 'vitest';
import { DeterministicProvider } from '../src/providers/test.js';
import { realTuiHarness } from './tui.real-harness.js';

it('inspects automatic-note provenance and undoes learning through the real terminal management menu', async () => {
  const h = await realTuiHarness();
  try {
    vi.mocked(DeterministicProvider.prototype.stream).mockImplementation(async function* (request) {
      if (request.conversationId?.startsWith('knowledge:'))
        yield {
          type: 'done',
          text: JSON.stringify({
            candidates: [
              {
                kind: 'preference',
                topic: 'ui.controls',
                content: 'The user prefers blue controls for this project.',
                scope: 'workspace',
                sourceQuote: 'I prefer blue controls for this project',
                evidenceCallIds: [],
                confidence: 'high',
              },
            ],
          }),
        };
      else yield { type: 'done', text: 'Understood.' };
    });
    const accepted = await h.api('/api/runs', {
      threadId: h.created.thread.id,
      input: 'I prefer blue controls for this project.',
    });
    expect((await h.daemon.runtime.waitForRun(accepted.body.id)).status).toBe('completed');
    await expect
      .poll(async () =>
        (await h.api('/api/memory')).body.memories.find(
          (note: { content: string }) =>
            note.content === 'The user prefers blue controls for this project.',
        ),
      )
      .toBeDefined();
    await h.command('/memory', 'Search memories');
    await h.send('blue controls');
    await h.send('\r', 'Origin: Learned automatically');
    await h.send('\u001b[6~', 'Source quote:');
    expect(h.frame()).toContain('I prefer blue controls for this project');
    await h.send('Undo');
    await h.send('\r', 'Learning undo verified');
    await h.send('\u001b[5~', 'State: disabled');
    const notes = (await h.api('/api/memory')).body.memories;
    expect(
      notes.find(
        (note: { content: string }) =>
          note.content === 'The user prefers blue controls for this project.',
      ),
    ).toMatchObject({ metadata: { knowledge: { origin: 'automatic', state: 'disabled' } } });
  } finally {
    await h.close();
  }
}, 15_000);
