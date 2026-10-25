import {
  type VoiceCapabilities,
  type VoiceEvent,
  type VoiceInterruptResponse,
  type VoiceSnapshot,
  type VoiceStartResponse,
  voiceLimits,
  voicePaths,
} from '../voice/types.js';
import { AUTH_EXPIRED_MESSAGE, AUTH_REQUIRED_MESSAGE } from './auth.js';
import {
  type VoiceApi,
  type VoiceAudio,
  type VoiceDependencies,
  VoicePublicError,
  voiceFailureMessage,
} from './voice.js';

type VoiceFetch = (path: string, init?: RequestInit) => Promise<Response>;
export function voiceBrowserSupport(features: {
  secure: boolean;
  microphone: boolean;
  peer: boolean;
}): string | null {
  if (!features.secure)
    return 'Voice requires HTTPS or browser-local localhost/127.0.0.1. Use private Tailscale Serve or an SSH tunnel; ordinary HTTP to a LAN or tailnet IP cannot access the microphone.';
  if (!features.microphone)
    return 'This browser does not support microphone capture. Text chat remains available.';
  if (!features.peer) return 'This browser does not support WebRTC. Text chat remains available.';
  return null;
}

export function createVoiceApi(
  basePath: string,
  fetcher: VoiceFetch = fetch,
  createEventSource: (path: string) => EventSource = (path) => new EventSource(path),
): VoiceApi {
  const path = (relative: string) => `${basePath.replace(/\/?$/u, '/')}${relative}`;
  const request = async <T>(relative: string, body?: unknown): Promise<T> => {
    const response = await fetcher(path(relative), {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(voiceLimits.startTimeoutMs),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401)
        throw new VoicePublicError(
          data?.code === 'AUTH_EXPIRED' ? AUTH_EXPIRED_MESSAGE : AUTH_REQUIRED_MESSAGE,
        );
      if (
        typeof data?.error?.code === 'string' &&
        data.error.code.startsWith('VOICE_') &&
        typeof data.error.message === 'string'
      )
        throw new VoicePublicError(
          voiceFailureMessage({ code: data.error.code, message: data.error.message.slice(0, 500) }),
        );
      throw new VoicePublicError(
        `Voice daemon request failed (${response.status}). Text chat remains available.`,
      );
    }
    if (!data || typeof data !== 'object')
      throw new VoicePublicError('Voice daemon returned an invalid response.');
    return data as T;
  };
  return {
    capabilities: () => request<VoiceCapabilities>(voicePaths.capabilities),
    start: (body) => request<VoiceStartResponse>(voicePaths.sessions, body),
    heartbeat: (id, body) => request<VoiceSnapshot>(voicePaths.heartbeat(id), body),
    stop: (id, body) => request<VoiceSnapshot>(voicePaths.stop(id), body),
    interrupt: (id, body) => request<VoiceInterruptResponse>(voicePaths.interrupt(id), body),
    subscribe: (id, onEvent, onError) => {
      const source = createEventSource(path(voicePaths.events(id)));
      let closed = false;
      const failed = () => {
        if (closed) return;
        closed = true;
        source.close();
        onError();
      };
      source.addEventListener('voice', (message) => {
        if (closed) return;
        try {
          if (
            !(message instanceof MessageEvent) ||
            message.data.length > voiceLimits.maxEventBytes
          ) {
            failed();
            return;
          }
          const event = JSON.parse(message.data) as VoiceEvent;
          if (
            event.v !== 1 ||
            !Number.isSafeInteger(event.seq) ||
            !Number.isSafeInteger(event.revision) ||
            !event.payload
          ) {
            failed();
            return;
          }
          onEvent(event);
        } catch {
          failed();
        }
      });
      // No autonomous voice reconnection. A broken lease stream ends foreground media.
      source.onerror = failed;
      return () => {
        closed = true;
        source.onerror = null;
        source.close();
      };
    },
  };
}

export function createBrowserVoiceDependencies(
  basePath: string,
  audio: VoiceAudio,
): VoiceDependencies {
  return {
    api: createVoiceApi(basePath),
    audio,
    capture: () =>
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false }),
    createPeer: () => new RTCPeerConnection(),
    uuid: () => crypto.randomUUID(),
    unsupported: () =>
      voiceBrowserSupport({
        secure: window.isSecureContext,
        microphone: typeof navigator.mediaDevices?.getUserMedia === 'function',
        peer: typeof RTCPeerConnection === 'function',
      }),
    now: () => Date.now(),
    schedule: (callback, delay) => {
      const timer = window.setTimeout(callback, delay);
      return () => window.clearTimeout(timer);
    },
  };
}
