import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { MatrixBridge } from '../src/integrations/matrix.js';
import { identityHarness } from './identity.harness.js';

it('uses the same frozen instruction lifecycle for Matrix messages and metadata-only explicit refresh commands', async () => {
  let receive: Parameters<MatrixBridge['start']>[0] | undefined;
  const start = vi.spyOn(MatrixBridge.prototype, 'start').mockImplementation(async (callback) => {
    receive = callback;
  });
  const sent: string[] = [];
  const send = vi
    .spyOn(MatrixBridge.prototype, 'sendText')
    .mockImplementation(async (_room, body) => {
      sent.push(body);
      return { eventId: '$fixture' };
    });
  const receipt = vi.spyOn(MatrixBridge.prototype, 'sendReceipt').mockResolvedValue();
  const typing = vi.spyOn(MatrixBridge.prototype, 'setTyping').mockResolvedValue();
  let h: Awaited<ReturnType<typeof identityHarness>> | undefined;
  try {
    h = await identityHarness(undefined, (config) => {
      config.features.matrix = true;
      config.matrix.enabled = true;
      config.matrix.accessToken = 'fixture-only-not-a-real-token';
      config.matrix.userId = '@bot:fixture';
      config.matrix.allowedUsers = ['@owner:fixture'];
      config.matrix.reactions = false;
    });
    await writeFile(join(h.root, 'SOUL.md'), 'MATRIX_PRIVATE_SOUL');
    await writeFile(join(h.root, 'AGENTS.md'), 'MATRIX_PRIVATE_AGENTS_1');
    const message = async (body: string) => {
      if (!receive) throw new Error('Matrix handler not installed');
      await receive({
        roomId: '!fixture:fixture',
        eventId: `$${sent.length}-${body.length}`,
        sender: '@owner:fixture',
        body,
      });
    };
    await message('Fixture reply; do not use tools.');
    expect(h.observed.at(-1)?.systemPrompt).toContain('MATRIX_PRIVATE_SOUL');
    expect(h.observed.at(-1)?.systemPrompt).toContain('MATRIX_PRIVATE_AGENTS_1');
    await message('/identity');
    expect(sent.at(-1)).toContain('Identity revision 1');
    expect(sent.at(-1)).not.toContain('MATRIX_PRIVATE_AGENTS_1');
    await writeFile(join(h.root, 'AGENTS.md'), 'MATRIX_PRIVATE_AGENTS_2');
    await message('Another fixture; do not use tools.');
    expect(h.observed.at(-1)?.systemPrompt).toContain('MATRIX_PRIVATE_AGENTS_1');
    await message('/identity refresh');
    expect(sent.at(-1)).toContain('Identity revision 2');
    await message('Final fixture; do not use tools.');
    expect(h.observed.at(-1)?.systemPrompt).toContain('MATRIX_PRIVATE_AGENTS_2');
  } finally {
    await h?.close();
    start.mockRestore();
    send.mockRestore();
    receipt.mockRestore();
    typing.mockRestore();
  }
}, 15000);

it('captures background-session instruction files at first creation and retains them on later scheduled runs', async () => {
  const h = await identityHarness();
  try {
    await writeFile(join(h.root, 'SOUL.md'), 'BACKGROUND_SOUL');
    await writeFile(join(h.root, 'AGENTS.md'), 'BACKGROUND_AGENTS_1');
    const schedule = h.daemon.scheduler.create({
      name: 'Identity schedule',
      type: 'interval',
      expression: '86400',
      agentInput: 'Fixture reply; do not use tools.',
      enabled: false,
    });
    await h.daemon.scheduler.trigger(schedule.id);
    expect(h.observed.at(-1)?.systemPrompt).toContain('BACKGROUND_SOUL');
    expect(h.observed.at(-1)?.systemPrompt).toContain('BACKGROUND_AGENTS_1');
    await writeFile(join(h.root, 'AGENTS.md'), 'BACKGROUND_AGENTS_2');
    await h.daemon.scheduler.trigger(schedule.id);
    expect(h.observed.at(-1)?.systemPrompt).toContain('BACKGROUND_AGENTS_1');
    const session = h.daemon.runtime
      .listSessions()
      .find((entry) => entry.sourceKey === `schedule:${schedule.id}`);
    if (!session) throw new Error('Missing background session');
    h.daemon.runtime.refreshSessionIdentity(session.id);
    await h.daemon.scheduler.trigger(schedule.id);
    expect(h.observed.at(-1)?.systemPrompt).toContain('BACKGROUND_AGENTS_2');
  } finally {
    await h.close();
  }
}, 15000);
