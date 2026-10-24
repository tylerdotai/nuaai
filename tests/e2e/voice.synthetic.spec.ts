// Isolated generated-tone rendering acceptance. No microphone capture, provider or speech.
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import { type VoiceEvent, voiceLimits } from '../../src/voice/types.js';
import type { VoiceController } from '../../src/web/voice.js';

type FixtureWindow = Window & {
  VoiceSynthetic: { VoiceController: typeof VoiceController };
  voiceSynthetic: {
    controller: VoiceController;
    context: AudioContext;
    oscillator: OscillatorNode;
    analyser: AnalyserNode;
    stream: MediaStream;
    peerClosed: number;
    channelClosed: number;
    stops: number;
    timers: Set<number>;
    error: string | null;
  };
};

test('generated audio reaches real browser playback while lease controls and teardown remain independent', async ({
  page,
}) => {
  const bundle = buildSync({
    entryPoints: [resolve('src/web/voice.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'VoiceSynthetic',
    write: false,
    platform: 'browser',
  });
  await page.setContent(
    '<button id="start">Start generated-tone acceptance</button><audio id="audio"></audio>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((limits) => {
    document.querySelector('#start')?.addEventListener(
      'click',
      () => {
        void (async () => {
          const fixture = window as unknown as FixtureWindow;
          const context = new AudioContext();
          await context.resume();
          const oscillator = context.createOscillator();
          oscillator.frequency.value = 440;
          const gain = context.createGain();
          gain.gain.value = 0.01;
          const analyser = context.createAnalyser();
          const destination = context.createMediaStreamDestination();
          oscillator.connect(gain).connect(analyser).connect(destination);
          oscillator.start();
          const audio = document.querySelector('audio') as HTMLAudioElement;
          const timers = new Set<number>();
          const voice = {
            sessionId: 'synthetic-session',
            threadId: 'synthetic-thread',
            id: 'synthetic-lease',
            generation: 1,
            revision: 1,
            phase: 'negotiating' as const,
            taskMode: 'daemon' as const,
            transport: 'webrtc' as const,
            billing: 'subscription-only' as const,
            leaseExpiresAt: Date.now() + 30_000,
            expiresAt: Date.now() + 600_000,
          };
          let receive: ((event: VoiceEvent) => void) | undefined;
          const counters = { peerClosed: 0, channelClosed: 0, stops: 0 };
          const peer = {
            localDescription: null as RTCSessionDescriptionInit | null,
            iceGatheringState: 'complete',
            connectionState: 'connected',
            ontrack: null as
              | ((event: { streams: MediaStream[]; track: MediaStreamTrack }) => void)
              | null,
            onconnectionstatechange: null,
            createDataChannel: () => ({
              close: () => {
                counters.channelClosed++;
              },
              onclose: null,
              onerror: null,
            }),
            createOffer: async () => ({ type: 'offer' as const, sdp: 'synthetic-offer' }),
            setLocalDescription: async (description: RTCSessionDescriptionInit) => {
              peer.localDescription = description;
            },
            setRemoteDescription: async () => {},
            addTrack: () => {},
            close: () => {
              counters.peerClosed++;
            },
          };
          const controller = new fixture.VoiceSynthetic.VoiceController(
            { sessionId: voice.sessionId, threadId: voice.threadId },
            {
              api: {
                capabilities: async () => ({
                  v: 1,
                  available: true,
                  transport: 'webrtc',
                  protocol: 'v3',
                  outputModality: 'audio',
                  billing: 'subscription-only',
                  taskMode: 'daemon',
                  interruption: 'unsupported',
                  blockers: [],
                  limits,
                }),
                start: async () => ({ voice, answer: { type: 'answer', sdp: 'synthetic-answer' } }),
                heartbeat: async () => voice,
                stop: async () => {
                  counters.stops++;
                  return { ...voice, phase: 'closed' };
                },
                interrupt: async () => ({ voice, status: 'accepted' }),
                subscribe: (_id, callback) => {
                  receive = callback;
                  return () => {
                    receive = undefined;
                  };
                },
              },
              capture: async () => destination.stream, // Generated MediaStream, never getUserMedia.
              createPeer: () => peer as unknown as RTCPeerConnection,
              audio,
              uuid: () => 'synthetic-request',
              unsupported: () => null,
              now: Date.now,
              schedule: (callback, delay) => {
                const id = window.setTimeout(() => {
                  timers.delete(id);
                  callback();
                }, delay);
                timers.add(id);
                return () => {
                  clearTimeout(id);
                  timers.delete(id);
                };
              },
            },
          );
          fixture.voiceSynthetic = {
            controller,
            context,
            oscillator,
            analyser,
            stream: destination.stream,
            timers,
            get peerClosed() {
              return counters.peerClosed;
            },
            get channelClosed() {
              return counters.channelClosed;
            },
            get stops() {
              return counters.stops;
            },
            error: null,
          };
          await controller.loadCapabilities();
          await controller.connect();
          receive?.({
            v: 1,
            voiceId: voice.id,
            generation: 1,
            revision: 1,
            seq: 1,
            sessionId: voice.sessionId,
            threadId: voice.threadId,
            type: 'voice.result.delivery',
            payload: {
              runId: 'synthetic-run',
              deliveryId: 'synthetic-delivery',
              status: 'accepted',
            },
          });
          peer.ontrack?.({
            streams: [destination.stream],
            track: destination.stream.getAudioTracks()[0],
          });
        })().catch(() => {
          const fixture = window as unknown as FixtureWindow;
          if (fixture.voiceSynthetic) fixture.voiceSynthetic.error = 'Synthetic audio setup failed';
        });
      },
      { once: true },
    );
  }, voiceLimits);
  await page.click('#start');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).voiceSynthetic?.controller.getState().playback,
      ),
    )
    .toBe('playing');
  const evidence = await page.evaluate(() => {
    const f = (window as unknown as FixtureWindow).voiceSynthetic;
    const waveform = new Float32Array(f.analyser.fftSize);
    f.analyser.getFloatTimeDomainData(waveform);
    return {
      energy: waveform.reduce((total, value) => total + value * value, 0),
      mediaTime: (document.querySelector('audio') as HTMLAudioElement).currentTime,
      deliveries: f.controller.getState().deliveries,
      error: f.error,
    };
  });
  expect(evidence.error).toBeNull();
  expect(evidence.energy).toBeGreaterThan(0);
  expect(evidence.mediaTime).toBeGreaterThan(0);
  expect(evidence.deliveries).toEqual([
    { runId: 'synthetic-run', deliveryId: 'synthetic-delivery', status: 'accepted' },
  ]);
  const released = await page.evaluate(async () => {
    const f = (window as unknown as FixtureWindow).voiceSynthetic;
    await f.controller.hangup();
    f.oscillator.stop();
    await f.context.close();
    return {
      tracks: f.stream.getTracks().map((track) => track.readyState),
      peerClosed: f.peerClosed,
      channelClosed: f.channelClosed,
      stops: f.stops,
      timers: f.timers.size,
      state: f.controller.getState(),
      outputCleared: (document.querySelector('audio') as HTMLAudioElement).srcObject === null,
    };
  });
  expect(released.tracks).toEqual(['ended']);
  expect(released).toMatchObject({
    peerClosed: 1,
    channelClosed: 1,
    stops: 1,
    timers: 0,
    outputCleared: true,
    state: { phase: 'ended', playback: 'ended', microphone: 'ended' },
  });
});
