/** Voice wire v1. Negotiation data is ephemeral and must never enter durable events. */
export const voiceContractVersion = 1 as const;
export const voiceLimits = {
  startTimeoutMs: 20_000,
  heartbeatIntervalMs: 10_000,
  leaseMs: 30_000,
  maxDurationMs: 600_000,
  maxSessions: 2,
  maxSdpBytes: 96 * 1_024,
  maxBodyBytes: 128 * 1_024,
  maxTranscriptBytes: 16 * 1_024,
  maxEvents: 256,
  maxEventBytes: 1_024 * 1_024,
} as const;

export type VoiceFailureCode =
  | 'VOICE_DISABLED'
  | 'VOICE_EXECUTION_ISOLATION_UNVERIFIED'
  | 'VOICE_CODEX_UNAVAILABLE'
  | 'VOICE_UNSUPPORTED_VERSION'
  | 'VOICE_CODEX_LOGIN_REQUIRED'
  | 'VOICE_SUBSCRIPTION_REQUIRED'
  | 'VOICE_ACCESS_DENIED'
  | 'VOICE_QUOTA_EXCEEDED'
  | 'VOICE_RATE_LIMITED'
  | 'VOICE_PROVIDER_ERROR'
  | 'VOICE_PROTOCOL_ERROR'
  | 'VOICE_AUTHORITY_VIOLATION'
  | 'VOICE_PROVIDER_DISCONNECTED'
  | 'VOICE_NEGOTIATION_TIMEOUT'
  | 'VOICE_NEGOTIATION_EXPIRED'
  | 'VOICE_BINDING_CONFLICT'
  | 'VOICE_REQUEST_CONFLICT'
  | 'VOICE_STALE_GENERATION'
  | 'VOICE_BUSY'
  | 'VOICE_INVALID_REQUEST'
  | 'VOICE_PAYLOAD_TOO_LARGE'
  | 'VOICE_FORBIDDEN'
  | 'VOICE_NOT_FOUND'
  | 'VOICE_LEASE_EXPIRED'
  | 'VOICE_DURATION_EXCEEDED'
  | 'VOICE_INTERRUPTION_UNSUPPORTED'
  | 'VOICE_DELIVERY_UNKNOWN'
  | 'VOICE_CLEANUP_FAILED';

export interface VoiceFailure {
  code: VoiceFailureCode;
  message: string;
  retryable: boolean;
  stage: 'preflight' | 'start' | 'signaling' | 'active' | 'stop' | 'delivery';
}
export interface VoiceErrorResponse {
  error: VoiceFailure;
}
export type VoicePhase = 'starting' | 'negotiating' | 'active' | 'stopping' | 'closed' | 'failed';
export type VoiceTaskMode = 'disabled' | 'daemon';
export interface VoiceBinding {
  sessionId: string;
  threadId: string;
}
export interface VoiceCapabilities {
  v: 1;
  available: boolean;
  transport: 'webrtc';
  protocol: 'v3';
  outputModality: 'audio';
  billing: 'subscription-only';
  taskMode: VoiceTaskMode;
  interruption: 'unsupported' | 'provider';
  limits: typeof voiceLimits;
  blockers: VoiceFailure[];
}
export interface VoiceStartRequest extends VoiceBinding {
  requestId: string;
  offer: { type: 'offer'; sdp: string };
}
export interface VoiceSnapshot extends VoiceBinding {
  id: string;
  generation: number;
  revision: number;
  phase: VoicePhase;
  taskMode: VoiceTaskMode;
  transport: 'webrtc';
  billing: 'subscription-only';
  expiresAt: number;
  leaseExpiresAt: number;
  failure?: VoiceFailure;
}
export interface VoiceStartResponse {
  voice: VoiceSnapshot;
  answer: { type: 'answer'; sdp: string };
}
export interface VoiceControlRequest {
  generation: number;
}
export interface VoiceObservation {
  peerState: 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
  muted: boolean;
  playback: 'unknown' | 'blocked' | 'playing' | 'stopped';
}
export interface VoiceHeartbeatRequest extends VoiceControlRequest {
  observation: VoiceObservation;
}
export interface VoiceStopRequest extends VoiceControlRequest {
  reason: 'hangup' | 'navigation' | 'client_error';
}
/** Cancels current speech only; never cancels durable work or grants approval. */
export interface VoiceInterruptRequest extends VoiceControlRequest {
  requestId: string;
}
export interface VoiceInterruptResponse {
  voice: VoiceSnapshot;
  status: 'accepted'; // provider accepted control; not proof buffered audio is gone
}
export interface VoiceTranscript {
  itemId: string;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
}
export interface VoiceHandoff {
  handoffId: string;
  runId: string;
}
export interface VoiceDelivery {
  runId: string;
  deliveryId: string;
  status: 'pending' | 'accepted' | 'unknown' | 'failed' | 'interrupted';
}
type VoiceEventPayload =
  | { type: 'voice.state'; payload: VoiceSnapshot }
  | { type: 'voice.transcript'; payload: VoiceTranscript }
  | { type: 'voice.run.linked'; payload: VoiceHandoff }
  | { type: 'voice.result.delivery'; payload: VoiceDelivery }
  | { type: 'voice.observation'; payload: VoiceObservation & { source: 'browser' } }
  | { type: 'voice.error'; payload: VoiceFailure }
  | { type: 'voice.resync'; payload: VoiceSnapshot };
export type VoiceEvent = VoiceBinding & {
  v: 1;
  voiceId: string;
  generation: number;
  seq: number;
  revision: number;
} & VoiceEventPayload;

/** All paths are relative to the app mount; all operations require daemon authentication. */
export const voicePaths = {
  capabilities: 'api/voice/capabilities',
  sessions: 'api/voice/sessions',
  session: (id: string) => `api/voice/sessions/${encodeURIComponent(id)}`,
  events: (id: string) => `api/voice/sessions/${encodeURIComponent(id)}/events`,
  heartbeat: (id: string) => `api/voice/sessions/${encodeURIComponent(id)}/heartbeat`,
  stop: (id: string) => `api/voice/sessions/${encodeURIComponent(id)}/stop`,
  interrupt: (id: string) => `api/voice/sessions/${encodeURIComponent(id)}/interrupt`,
} as const;
// GET capabilities/session/events; POST sessions/heartbeat/stop/interrupt.
// Session/heartbeat/stop return VoiceSnapshot directly. SSE uses event: voice, data: VoiceEvent.
// Optional events ?after=<seq> or Last-Event-ID: <seq>; gaps produce voice.resync.
// Existing middleware AUTH_REQUIRED/AUTH_EXPIRED responses remain unchanged.
// Hang-up ends lease/media/delivery only: admitted durable runs survive.
