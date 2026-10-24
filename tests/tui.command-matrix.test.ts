import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { tuiCommands } from '../src/ui/tui-commands.js';
import { realTuiHarness } from './tui.real-harness.js';

it('exercises every registered TUI command against a real authenticated daemon with durable mutation readback', async () => {
  const h = await realTuiHarness();
  const results: Array<{ command: string; reaction: string; frame: string }> = [];
  const run = async (command: string, reaction: string) => {
    await h.command(command, reaction);
    results.push({ command: command.split(' ')[0].slice(1), reaction, frame: h.frame() });
  };
  try {
    for (const [command, reaction] of [
      ['/help', 'Commands and shortcuts'],
      ['/status', 'Runtime status'],
      ['/settings', 'Settings'],
      ['/permissions', 'Approval mode'],
      ['/identity', 'Session identity'],
      ['/identity-refresh', 'Refresh session identity?'],
      ['/sessions', 'Conversations'],
      ['/threads', 'Threads'],
      ['/model', 'Choose model'],
      ['/provider', 'Choose provider'],
      ['/skills', 'Skills · select to toggle'],
      ['/plugins', 'Trusted plugins'],
      ['/tasks', 'Background tasks'],
      ['/schedules', 'Automations'],
      ['/memory', 'Search memories'],
      ['/approvals', 'No pending approvals'],
      ['/outputs', 'Conversation outputs'],
      ['/attach', 'Attach file'],
      ['/attachments', 'Pending attachments'],
      ['/search', 'Search conversation'],
      ['/search-next', 'Search this conversation first'],
      ['/search-prev', 'Search this conversation first'],
      ['/cancel', 'No active run'],
      ['/resume', 'No interrupted run'],
      ['/refresh', 'Runtime refreshed'],
      ['/chat', 'Enter send'],
    ])
      await run(command, reaction);
    await run('/new Acceptance conversation', 'Acceptance conversation');
    let session = h.daemon.store.listSessions().find((s) => s.title === 'Acceptance conversation');
    if (!session) throw new Error('New conversation was not persisted.');
    const sessionId = session.id;
    await run('/rename Renamed acceptance', 'Title saved');
    session = h.daemon.store.getSession(sessionId);
    expect(session?.title).toBe('Renamed acceptance');
    await run('/thread Acceptance branch', 'Acceptance branch');
    let branch = h.daemon.store.listThreads(sessionId).find((t) => t.title === 'Acceptance branch');
    if (!branch) throw new Error('New thread was not persisted.');
    const branchId = branch.id;
    await run('/rename-thread Renamed branch', 'Title saved');
    branch = h.daemon.store.getThread(branchId);
    expect(branch?.title).toBe('Renamed branch');
    await run('/remember ACCEPTANCE_MEMORY_SENTINEL', 'Memory saved');
    expect(JSON.stringify((await h.api('/api/memory')).body)).toContain(
      'ACCEPTANCE_MEMORY_SENTINEL',
    );
    await run('/memory', 'Search memories');
    await h.send('ACCEPTANCE_MEMORY_SENTINEL', 'ACCEPTANCE_MEMORY_SENTINEL');
    await h.send('\r', 'Memory details');
    await run(
      '/schedule Acceptance automation|manual|manual|Respond with acceptance.',
      'Schedule saved',
    );
    const schedule = (await h.api('/api/schedules')).body.schedules.find(
      (s: { name: string }) => s.name === 'Acceptance automation',
    );
    expect(schedule.agentInput).toBe('Respond with acceptance.');
    await run(
      `/schedule-edit ${schedule.id}|Edited automation|manual|manual|Respond with edited acceptance.`,
      'Schedule changes saved',
    );
    expect(
      (await h.api('/api/schedules')).body.schedules.find(
        (s: { id: string }) => s.id === schedule.id,
      ).agentInput,
    ).toBe('Respond with edited acceptance.');
    await run(
      '/skill-create acceptance-workflow|Use ACCEPTANCE_SKILL_SENTINEL to verify workflow results.',
      'Skill created',
    );
    await run('/skill acceptance-workflow', 'ACCEPTANCE_SKILL_SENTINEL');
    const file = join(h.root, 'acceptance-source.txt');
    await writeFile(file, 'ATTACHMENT_MATRIX_SENTINEL');
    await run(`/attach ${file}`, 'Attached acceptance-source.txt');
    await run('/attachments', 'Remove acceptance-source.txt');
    await h.send('\r', 'Attachment removed');
    const destination = join(h.root, 'acceptance-export.md');
    await run(`/export ${destination}`, 'Export saved:');
    expect(await readFile(destination, 'utf8')).toContain('Renamed branch');
    await run('/delete-thread', 'Confirm deletion');
    expect(h.daemon.store.getThread(branchId)).toBeTruthy();
    await h.send('\u001b[B', 'Delete permanently');
    await h.send('\r', 'Deletion verified');
    expect(h.daemon.store.getThread(branchId)).toBeUndefined();
    await run('/delete', 'Confirm deletion');
    expect(h.daemon.store.getSession(sessionId)).toBeTruthy();
    await h.send('\u001b[B', 'Delete permanently');
    await h.send('\r', 'Deletion verified');
    expect(h.daemon.store.getSession(sessionId)).toBeUndefined();
    await h.home();
    await h.send('/quit', '/quit');
    await h.send('\r');
    await h.exited;
    expect((await h.api('/api/sessions')).status).toBe(200);
    results.push({
      command: 'quit',
      reaction: 'Client exited; daemon stayed available',
      frame: '',
    });
    expect([...new Set(results.map((r) => r.command))].sort()).toEqual(
      tuiCommands.map((c) => c.command).sort(),
    );
  } finally {
    await writeFile(
      process.env.NUAAI_COMMAND_REPORT ?? join(h.root, 'command-results.json'),
      JSON.stringify(results, null, 2),
    );
    await h.close();
  }
}, 90000);
