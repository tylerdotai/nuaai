import { useEffect, useRef, useState } from 'react';
import { createBrowserVoiceDependencies } from '../voice-client.js';
import { VoiceController, type VoiceState } from '../voice.js';
import './voice-panel.css';

const idle: VoiceState = {
  phase: 'idle',
  capabilities: null,
  voice: null,
  microphone: 'none',
  transport: 'new',
  remoteTrack: false,
  playback: 'idle',
  transcripts: [],
  handoffs: [],
  deliveries: [],
  interruption: 'none',
  error: null,
};

export function VoicePanel({
  sessionId,
  threadId,
  basePath,
  disabled,
  runStatus,
}: {
  sessionId: string;
  threadId: string;
  basePath: string;
  disabled: boolean;
  runStatus: Record<string, string>;
}): React.JSX.Element {
  const controller = useRef<VoiceController | null>(null);
  const [state, setState] = useState<VoiceState>(idle);
  useEffect(() => {
    // Playback is controlled by the labelled buttons and visible live transcript below.
    // A detached audio element needs no inaccessible hidden native controls.
    const voice = new VoiceController(
      { sessionId, threadId },
      createBrowserVoiceDependencies(basePath, new Audio()),
    );
    controller.current = voice;
    const unsubscribe = voice.subscribe(setState);
    const leave = () => {
      if (['requesting-mic', 'negotiating', 'connected'].includes(voice.getState().phase))
        void voice.hangup('navigation');
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') leave();
    };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', visibility);
      unsubscribe();
      voice.dispose();
      controller.current = null;
    };
  }, [sessionId, threadId, basePath]);
  useEffect(() => {
    if (disabled) void controller.current?.hangup('client_error');
  }, [disabled]);
  return (
    <>
      <VoicePanelView
        state={state}
        disabled={disabled}
        runStatus={runStatus}
        onConnect={() => {
          void controller.current?.connect();
        }}
        onHangup={() => {
          void controller.current?.hangup();
        }}
        onMute={() => controller.current?.setMuted(state.microphone !== 'muted')}
        onPlayback={() => {
          void controller.current?.enablePlayback();
        }}
        onInterrupt={() => {
          void controller.current?.interrupt();
        }}
        onRefresh={() => {
          void controller.current?.loadCapabilities();
        }}
      />
    </>
  );
}

export function VoicePanelView({
  state,
  disabled,
  runStatus,
  onConnect,
  onHangup,
  onMute,
  onPlayback,
  onInterrupt,
  onRefresh,
}: {
  state: VoiceState;
  disabled: boolean;
  runStatus: Record<string, string>;
  onConnect: () => void;
  onHangup: () => void;
  onMute: () => void;
  onPlayback: () => void;
  onInterrupt: () => void;
  onRefresh: () => void;
}): React.JSX.Element {
  const active = ['requesting-mic', 'negotiating', 'connected'].includes(state.phase);
  return (
    <details
      className="voice-panel"
      aria-label="Foreground voice"
      onToggle={(event) => {
        if (!event.currentTarget.open && active) onHangup();
        else if (
          event.currentTarget.open &&
          !disabled &&
          !state.capabilities &&
          state.phase === 'idle'
        )
          onRefresh();
      }}
    >
      <summary>
        Voice · {state.phase === 'blocked' ? 'unavailable' : state.phase} · managed subscription
      </summary>
      <p className="voice-guidance">
        Start voice explicitly to send microphone audio to the provider. Requires HTTPS or
        browser-local localhost. No Platform API-key fallback. Text chat remains available.
      </p>
      <div className="voice-controls">
        <button
          type="button"
          disabled={
            disabled ||
            active ||
            !state.capabilities?.available ||
            state.phase === 'blocked' ||
            state.phase === 'preflight'
          }
          onClick={onConnect}
        >
          Start voice
        </button>
        <button
          type="button"
          aria-pressed={state.microphone === 'muted'}
          disabled={!active || state.microphone === 'none'}
          onClick={onMute}
        >
          Mute microphone
        </button>
        <button type="button" disabled={!active} onClick={onHangup}>
          Hang up
        </button>
        {state.playback === 'blocked' && (
          <button type="button" onClick={onPlayback}>
            Enable audio playback
          </button>
        )}
        {active && state.capabilities?.interruption === 'provider' && (
          <button
            type="button"
            disabled={!state.voice || state.interruption === 'requested'}
            onClick={onInterrupt}
          >
            Interrupt speech
          </button>
        )}
        {!active && (
          <button
            type="button"
            disabled={disabled || state.phase === 'preflight'}
            onClick={onRefresh}
          >
            Check voice availability
          </button>
        )}
      </div>
      <output aria-live="polite" aria-atomic="true">
        Voice: {state.phase}. Daemon lease: {state.voice?.phase ?? 'none'}. Microphone:{' '}
        {state.microphone}. Transport: {state.transport}.{' '}
        {state.remoteTrack ? 'Audio track connected' : 'No remote audio track'}. Playback:{' '}
        {state.playback === 'playing'
          ? 'started in browser (audibility not verified)'
          : state.playback}
        .
      </output>
      {state.error && (
        <p className="voice-error" role="alert">
          {state.error}
        </p>
      )}
      {state.interruption !== 'none' && (
        <p>
          Speech interruption: {state.interruption}. Acceptance is not proof buffered audio has
          stopped. Durable work continues.
        </p>
      )}
      <p className="voice-guidance">
        Foreground only. Leaving this conversation or hiding this page ends voice. Hang-up does not
        cancel admitted tasks; cancel work separately in conversation controls. Microphone mute does
        not mute response playback.
      </p>
      {state.transcripts.length > 0 && (
        <section className="voice-transcripts" aria-label="Live voice transcript">
          <p>Voice transcript (not execution evidence)</p>
          {state.transcripts.map((item) => (
            <p key={`${item.role}:${item.itemId}`}>
              <strong>
                {item.role} · {item.final ? 'final' : 'interim'}:{' '}
              </strong>
              {item.text}
            </p>
          ))}
        </section>
      )}
      {state.handoffs.length > 0 && (
        <ul aria-label="Voice-requested work">
          {state.handoffs.map((item) => (
            <li key={item.handoffId}>
              Run <code>{item.runId}</code> — Task:{' '}
              {runStatus[item.runId] ?? 'admitted; see conversation activity'}. Voice delivery:{' '}
              {state.deliveries
                .slice()
                .reverse()
                .find((delivery) => delivery.runId === item.runId)?.status ??
                (state.voice ? 'pending' : 'unavailable (voice ended)')}
              . Playback is observed separately above.
            </li>
          ))}
        </ul>
      )}
      {state.capabilities?.taskMode === 'disabled' && (
        <p>Voice task handoff is unavailable. Use text chat for work and approvals.</p>
      )}
    </details>
  );
}
