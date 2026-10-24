import { describe, expect, it } from 'vitest';
import { voiceContractVersion, voiceLimits, voicePaths } from '../src/voice/types.js';

describe('shared voice wire v1', () => {
  it('keeps every route mount-relative and encodes opaque lease IDs', () => {
    expect(voiceContractVersion).toBe(1);
    expect(voicePaths.capabilities).toBe('api/voice/capabilities');
    expect(voicePaths.sessions).toBe('api/voice/sessions');
    expect(voicePaths.session('../lease?')).toBe('api/voice/sessions/..%2Flease%3F');
    expect(voicePaths.events('lease/1')).toBe('api/voice/sessions/lease%2F1/events');
    expect(voicePaths.heartbeat('lease/1')).toBe('api/voice/sessions/lease%2F1/heartbeat');
    expect(voicePaths.stop('lease/1')).toBe('api/voice/sessions/lease%2F1/stop');
    expect(voicePaths.interrupt('lease/1')).toBe('api/voice/sessions/lease%2F1/interrupt');
  });
  it('publishes fixed local safety bounds, not subscription allowance', () => {
    expect(voiceLimits).toEqual({
      startTimeoutMs: 20_000,
      heartbeatIntervalMs: 10_000,
      leaseMs: 30_000,
      maxDurationMs: 600_000,
      maxSessions: 2,
      maxSdpBytes: 98_304,
      maxBodyBytes: 131_072,
      maxTranscriptBytes: 16_384,
      maxEvents: 256,
      maxEventBytes: 1_048_576,
    });
  });
});
