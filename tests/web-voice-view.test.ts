import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { type VoiceCapabilities, voiceLimits } from '../src/voice/types.js';
import { VoicePanelView } from '../src/web/components/VoicePanel.js';
import type { VoiceState } from '../src/web/voice.js';

const liveCapability: VoiceCapabilities = {
  v: 1,
  available: true,
  transport: 'webrtc',
  protocol: 'v3',
  outputModality: 'audio',
  billing: 'subscription-only',
  taskMode: 'daemon',
  interruption: 'unsupported',
  limits: voiceLimits,
  blockers: [],
};

function render(patch: Partial<VoiceState> = {}) {
  const state: VoiceState = {
    phase: 'connected',
    capabilities: {
      v: 1,
      available: true,
      transport: 'webrtc',
      protocol: 'v3',
      outputModality: 'audio',
      billing: 'subscription-only',
      taskMode: 'daemon',
      interruption: 'provider',
      limits: voiceLimits,
      blockers: [],
    },
    voice: null,
    microphone: 'muted',
    transport: 'connected',
    remoteTrack: true,
    playback: 'blocked',
    transcripts: [],
    handoffs: [{ handoffId: 'h1', runId: 'r1' }],
    deliveries: [{ runId: 'r1', deliveryId: 'd1', status: 'failed' }],
    interruption: 'none',
    error: null,
    ...patch,
  };
  return renderToStaticMarkup(
    createElement(VoicePanelView, {
      state,
      disabled: false,
      runStatus: { r1: 'completed' },
      onConnect: vi.fn(),
      onHangup: vi.fn(),
      onMute: vi.fn(),
      onPlayback: vi.fn(),
      onInterrupt: vi.fn(),
      onRefresh: vi.fn(),
    }),
  );
}

describe('voice UI evidence and accessible controls', () => {
  it('offers available subscription WebRTC voice without implying provider interruption or new login', () => {
    const markup = render({ phase: 'idle', capabilities: liveCapability });
    expect(markup).toContain('ChatGPT subscription · WebRTC v3');
    expect(markup).toContain('<button type="button">Start voice</button>');
    expect(markup).toContain('existing Codex/ChatGPT sign-in');
    expect(markup).toContain('voice quota');
    const connected = render({ capabilities: liveCapability });
    expect(connected).toContain('Speech interruption is unsupported');
    expect(connected).toContain('Muting only affects your microphone');
    expect(connected).not.toContain('>Interrupt speech<');
  });
  it('separates mute, hang-up, playback unblock, and task/delivery truth', () => {
    const markup = render();
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('Mute microphone');
    expect(markup).toContain('Hang up');
    expect(markup).toContain('Enable audio playback');
    expect(markup).toContain('Audio track connected');
    expect(markup).toContain('Task: completed');
    expect(markup).toContain('Voice delivery: failed');
    expect(markup).toContain('does not cancel');
    expect(markup).not.toContain('Audible');
  });
  it('shows provider unavailability and microphone guidance without claiming transport or playback success', () => {
    const markup = render({
      phase: 'blocked',
      error: 'Backing tool execution is not isolated.',
      remoteTrack: false,
      playback: 'idle',
      transport: 'new',
    });
    expect(markup).toContain('Backing tool execution is not isolated.');
    expect(markup).toContain('HTTPS');
    expect(markup).toContain('No remote audio track');
    expect(markup).toContain('<output aria-live="polite"');
    expect(markup).not.toContain('Audio track connected');
  });
  it('renders provider transcript as inert text and identifies interim versus final', () => {
    const markup = render({
      transcripts: [
        { itemId: 'x', role: 'assistant', text: '<script>fixture</script>', final: false },
      ],
    });
    expect(markup).toContain('&lt;script&gt;fixture&lt;/script&gt;');
    expect(markup).toContain('interim');
    expect(markup).not.toContain('<script>');
  });
});
