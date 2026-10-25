/**
 * Manual ONE real daemon/SQLite/runtime -> native transport -> reviewed Rust helper smoke.
 * Not matched by tests/**\/*.test.ts; npm/CI never executes a native binary automatically.
 * Run from root with Node22: node --import tsx tests/native/daemon-voice.manual.ts
 *   --binary /absolute/protected/offline-voice-helper --sha256 <approved e048... digest>
 * No Rust builds, provider auth, SDK WS, microphone or production provider activation.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VoiceProvider } from '../../src/voice/broker.js';
import type { VoiceEvent } from '../../src/voice/types.js';

declare module 'vitest' {
  interface ProvidedContext {
    nativeSmokeBinary: string;
    nativeSmokeSha256: string;
    nativeSmokeEvidence: string;
  }
}

const approvedElf = 'e048e1f808ca92671d3a85ce73debbc3a1fbbf16e5ddaa9d1ccce3f82c50c73f';
const voiceInputs = ['Synthetic offline task A', 'Synthetic offline task B'];
const survivorInput = 'Manual offline smoke: finish this durable text run after voice hangup.';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

if (process.env.VITEST !== 'true') {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== '--binary' ||
    args[2] !== '--sha256' ||
    !isAbsolute(args[1] ?? '') ||
    args[3] !== approvedElf
  )
    throw new Error('Require --binary <absolute reviewed helper> --sha256 <approved e048 digest>');
  if (Number(process.versions.node.split('.')[0]) !== 22)
    throw new Error('Use the approved Node22 test runtime');
  const binary = resolve(args[1]);
  if (
    createHash('sha256')
      .update(await readFile(binary))
      .digest('hex') !== approvedElf
  )
    throw new Error('Native helper digest mismatch; no daemon or native child started');
  const evidence = await mkdtemp(join(tmpdir(), 'nuaai-native-daemon-evidence-'));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const { startVitest } = await import('vitest/node');
  const context = await startVitest('test', [], {
    root,
    include: [relative(root, fileURLToPath(import.meta.url))],
    watch: false,
    fileParallelism: false,
    maxWorkers: 1,
    coverage: { enabled: false },
    provide: {
      nativeSmokeBinary: binary,
      nativeSmokeSha256: approvedElf,
      nativeSmokeEvidence: evidence,
    },
  });
  try {
    const files = context.state.getFiles();
    if (files.length !== 1 || files.some((file) => file.result?.state !== 'pass'))
      process.exitCode = 1;
  } finally {
    await context.close();
  }
  console.log(`Private smoke evidence: ${join(evidence, 'summary.json')}`);
} else {
  const { expect, inject, it, vi } = await import('vitest');
  it('real daemon durable runs traverse the real offline Rust helper and survive hangup', async () => {
    const { openActualHelper } = await import('./actual-helper-host.js');
    const { NativeVoiceTransport } = await import('../../src/voice/native-transport.js');
    const { createNativeChildWire } = await import('../../src/voice/native-wire.js');
    const original = await import('../../src/voice/codex-transport.js');
    const defaultBefore = original.unsupportedCodexVoiceProvider.availability();
    expect(defaultBefore.available).toBe(false);
    const binary = inject('nativeSmokeBinary');
    const digest = inject('nativeSmokeSha256');
    const evidence = inject('nativeSmokeEvidence');
    expect(digest).toBe(approvedElf);
    type Metadata = {
      type: string;
      commandId?: number;
      handoffId?: string;
      deliveryId?: string;
      status?: string;
    };
    const commands: Metadata[] = [];
    const events: Metadata[] = [];
    const metadata = (frame: unknown): Metadata => {
      const value = frame as Record<string, unknown>;
      return {
        type: String(value.type),
        ...(typeof value.commandId === 'number' ? { commandId: value.commandId } : {}),
        ...(typeof value.handoffId === 'string' ? { handoffId: value.handoffId } : {}),
        ...(typeof value.deliveryId === 'string' ? { deliveryId: value.deliveryId } : {}),
        ...(typeof value.status === 'string' ? { status: value.status } : {}),
      };
    };
    const gates = new Map([...voiceInputs, survivorInput].map((input) => [input, deferred()]));
    const entered = new Set<string>();
    const voiceEvents: VoiceEvent[] = [];
    let harness:
      | Awaited<ReturnType<typeof import('../identity.harness.js')['identityHarness']>>
      | undefined;
    let transport: InstanceType<typeof NativeVoiceTransport> | undefined;
    const streamAbort = new AbortController();
    let consume: Promise<void> | undefined;
    let success = false;
    let summary: Record<string, unknown> = {};
    const failures: unknown[] = [];
    const cleanup = async (action: () => unknown | Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    const host = await openActualHelper({
      binary,
      sha256: digest,
      evidenceRoot: join(evidence, 'native'),
    });
    try {
      const baseWire = createNativeChildWire(host.host);
      const activeTransport = new NativeVoiceTransport({
        send: (frame) => {
          commands.push(metadata(frame));
          baseWire.send(frame);
        },
        subscribe: (receive, failed) =>
          baseWire.subscribe((frame) => {
            events.push(metadata(frame));
            receive(frame);
          }, failed),
        close: () => baseWire.close(),
      });
      transport = activeTransport;
      let creations = 0;
      const provider: VoiceProvider = {
        availability: () => ({ available: true, taskMode: 'daemon', interruption: 'unsupported' }),
        create: () => {
          expect(++creations).toBe(1);
          return activeTransport;
        },
      };
      // Test-module injection only; original production provider object remains untouched.
      vi.doMock('../../src/voice/codex-transport.js', () => ({
        ...original,
        unsupportedCodexVoiceProvider: provider,
      }));
      const { identityHarness } = await import('../identity.harness.js');
      harness = await identityHarness(async (request) => {
        const input = request.messages.filter((message) => message.role === 'user').at(-1)?.content;
        const gate = input && gates.get(input);
        if (!input || !gate) throw new Error('Unexpected deterministic fixture input');
        entered.add(input);
        await gate.promise;
      });
      const h = harness;
      const origin = `http://127.0.0.1:${h.daemon.gateway.port}`;
      expect((await fetch(`${origin}/api/voice/capabilities`)).status).toBe(401);
      expect((await h.api('/api/voice/capabilities')).body).toMatchObject({
        available: true,
        taskMode: 'daemon',
      });
      const session = await h.api('/api/sessions', {
        title: 'Native offline daemon smoke',
        workspaceRoot: h.project,
      });
      expect(session.status).toBe(200);
      const threadId = session.body.thread.id as string;
      const started = await h.api('/api/voice/sessions', {
        sessionId: session.body.session.id,
        threadId,
        requestId: 'manual-native-daemon-once',
        offer: { type: 'offer', sdp: 'v=0\r\na=manual-private-offer\r\n' },
      });
      expect(started.status).toBe(201);
      expect(started.body.answer.type).toBe('answer');
      expect(typeof started.body.answer.sdp).toBe('string');
      const voiceId = started.body.voice.id as string;
      const generation = started.body.voice.generation as number;
      const sse = await fetch(`${origin}/api/voice/sessions/${voiceId}/events`, {
        headers: { authorization: `Bearer ${h.daemon.token}` },
        signal: streamAbort.signal,
      });
      expect(sse.status).toBe(200);
      const stream = sse.body;
      if (!stream) throw new Error('Missing real daemon SSE stream');
      consume = (async () => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            pending += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
            let boundary = pending.indexOf('\n\n');
            while (boundary >= 0) {
              const item = pending.slice(0, boundary);
              pending = pending.slice(boundary + 2);
              const data = item
                .split('\n')
                .find((line) => line.startsWith('data:'))
                ?.slice(5)
                .trim();
              if (data) voiceEvents.push(JSON.parse(data) as VoiceEvent);
              boundary = pending.indexOf('\n\n');
            }
          }
        } catch (error) {
          if (!streamAbort.signal.aborted) throw error;
        } finally {
          reader.releaseLock();
        }
      })();
      expect(
        (
          await h.api(`/api/voice/sessions/${voiceId}/heartbeat`, {
            generation,
            observation: { peerState: 'connected', muted: false, playback: 'unknown' },
          })
        ).status,
      ).toBe(200);
      await expect.poll(() => h.daemon.store.listRuns(threadId).length).toBe(2);
      const voiceRuns = h.daemon.store.listRuns(threadId);
      expect(new Set(voiceRuns.map((run) => run.input))).toEqual(new Set(voiceInputs));
      for (const run of voiceRuns) {
        expect(run.provider).toBe('deterministic');
        expect(h.daemon.store.getRunExecutionContext(run.id)?.permissionSource).toBe('web');
        expect(h.daemon.store.getRunExecutionContext(run.id)?.identitySnapshotId).toBeTruthy();
      }
      // Real runtime serializes a thread. Do not counterfeit reverse model completion.
      // Normal A->B delivery is correlated to the exact handoff/run/delivery IDs.
      await expect.poll(() => entered.has(voiceInputs[0])).toBe(true);
      expect(entered.has(voiceInputs[1])).toBe(false);
      gates.get(voiceInputs[0])?.resolve();
      await expect.poll(() => events.filter((event) => event.type === 'delivery').length).toBe(1);
      await expect.poll(() => entered.has(voiceInputs[1])).toBe(true);
      gates.get(voiceInputs[1])?.resolve();
      await expect.poll(() => events.filter((event) => event.type === 'delivery').length).toBe(2);
      await expect
        .poll(
          () =>
            voiceEvents.filter(
              (event) =>
                event.type === 'voice.result.delivery' && event.payload.status === 'accepted',
            ).length,
        )
        .toBe(2);
      const links = voiceEvents.filter((event) => event.type === 'voice.run.linked');
      expect(links).toHaveLength(2);
      const accepted = voiceEvents.filter(
        (event): event is Extract<VoiceEvent, { type: 'voice.result.delivery' }> =>
          event.type === 'voice.result.delivery' && event.payload.status === 'accepted',
      );
      const appends = commands.filter((command) => command.type === 'append');
      expect(appends).toHaveLength(2);
      expect(appends.map((command) => command.handoffId)).toEqual([
        'offline-handoff-A',
        'offline-handoff-B',
      ]);
      for (const link of links) {
        const run = voiceRuns.find((row) => row.id === link.payload.runId);
        expect(run).toBeDefined();
        const delivery = accepted.find((event) => event.payload.runId === link.payload.runId);
        expect(delivery).toBeDefined();
        const append = appends.find((command) => command.handoffId === link.payload.handoffId);
        expect(append?.deliveryId).toBe(delivery?.payload.deliveryId);
        expect(
          events.find(
            (event) => event.type === 'delivery' && event.commandId === append?.commandId,
          ),
        ).toEqual({
          type: 'delivery',
          commandId: append?.commandId,
          handoffId: link.payload.handoffId,
          deliveryId: delivery?.payload.deliveryId,
          status: 'accepted',
        });
      }
      // One ordinary durable HTTP control run proves hangup doesn't cancel active work,
      // in addition to preserving both completed native-handoff runs.
      const survivor = await h.api('/api/runs', { threadId, input: survivorInput });
      expect(survivor.status).toBe(200);
      await expect.poll(() => entered.has(survivorInput)).toBe(true);
      expect(h.daemon.store.getRun(survivor.body.id)?.status).toBe('running');
      const stopped = await h.api(`/api/voice/sessions/${voiceId}/stop`, {
        generation,
        reason: 'hangup',
      });
      expect(stopped.status).toBe(200);
      expect(stopped.body.phase).toBe('closed');
      expect(h.daemon.store.getRun(survivor.body.id)).toMatchObject({
        status: 'running',
        cancelRequested: false,
      });
      const native = host.finish();
      expect(native).toMatchObject({
        status: 0,
        eof: true,
        networkAttempts: 0,
        hashStable: true,
        descriptorGuardObserved: true,
      });
      gates.get(survivorInput)?.resolve();
      for (const id of [...voiceRuns.map((run) => run.id), survivor.body.id]) {
        expect((await h.daemon.runtime.waitForRun(id)).status).toBe('completed');
        expect(
          h.daemon.store.listRecentEventsForRun(id).some((event) => event.type === 'run.completed'),
        ).toBe(true);
        expect(
          h.daemon.store
            .listRecentEventsForRun(id)
            .some((event) => event.type === 'run.cancel_requested'),
        ).toBe(false);
      }
      streamAbort.abort();
      await consume;
      const durableIds = [...voiceRuns.map((run) => run.id), survivor.body.id];
      await h.restart();
      for (const id of durableIds)
        expect(h.daemon.store.getRun(id)).toMatchObject({
          status: 'completed',
          cancelRequested: false,
        });
      expect(commands.filter((command) => command.type === 'close')).toHaveLength(1);
      expect(commands.filter((command) => command.type === 'append')).toHaveLength(2);
      expect(original.unsupportedCodexVoiceProvider.availability()).toEqual(defaultBefore);
      expect(JSON.stringify(voiceEvents)).not.toContain('manual-private-offer');
      expect(JSON.stringify(voiceEvents)).not.toContain(started.body.answer.sdp);
      const durableEvents = JSON.stringify(h.daemon.store.listEvents());
      expect(durableEvents).not.toContain('manual-private-offer');
      expect(durableEvents).not.toContain(started.body.answer.sdp);
      success = true;
      summary = {
        native,
        nativeHandoffs: 2,
        durableVoiceRuns: 2,
        correlatedAcceptedDeliveries: 2,
        activeHttpRunSurvivedHangup: true,
        persistedCompletedRunsAfterRestart: durableIds.length,
        deliveryOrder: 'normal-thread-serialized-A-B',
        commands,
        events,
        limits:
          'Offline real daemon/runtime/SQLite and reviewed Rust memory helper only; no auth/provider/WS/audio acceptance',
      };
    } catch (error) {
      failures.push(error); // Keep the original body failure first, including assertion errors.
    } finally {
      await cleanup(() => {
        for (const gate of gates.values()) gate.resolve();
      });
      await cleanup(() => streamAbort.abort());
      await cleanup(() => consume);
      await cleanup(() => harness?.close());
      await cleanup(() => transport?.stop());
      await cleanup(() => host.close());
      await cleanup(() => vi.doUnmock('../../src/voice/codex-transport.js'));
      await cleanup(() =>
        writeFile(
          join(evidence, 'summary.json'),
          `${JSON.stringify({ ...summary, commands, events, success: success && failures.length === 0, failureCount: failures.length }, null, 2)}\n`,
          { flag: 'wx', mode: 0o600 },
        ),
      );
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Manual smoke and/or cleanup failed', {
        cause: failures[0],
      });
  }, 30_000);
}
