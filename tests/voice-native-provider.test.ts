import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeHelperEnvironment } from '../src/voice/native-provider.js';

afterEach(() => vi.unstubAllEnvs());
describe('native helper trusted environment', () => {
  it('preserves only trusted HOME/CODEX_HOME and fixed basic process settings', () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-no-inheritance');
    vi.stubEnv('HTTPS_PROXY', 'synthetic-no-inheritance');
    vi.stubEnv('NODE_OPTIONS', 'synthetic-no-inheritance');
    vi.stubEnv('CODEX_HOME', '/fixture/codex');
    const env = nativeHelperEnvironment({ home: '/fixture/home' });
    expect(env).toEqual({
      HOME: '/fixture/home',
      CODEX_HOME: '/fixture/codex',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
    });
    expect(JSON.stringify(env)).not.toContain('synthetic-no-inheritance');
  });
  it('uses explicit trusted host settings and rejects relative or malformed homes', () => {
    expect(
      nativeHelperEnvironment({ home: '/fixture/home', codexHome: '/fixture/managed' }).CODEX_HOME,
    ).toBe('/fixture/managed');
    expect(() => nativeHelperEnvironment({ home: 'relative' })).toThrow(/VOICE_CODEX_UNAVAILABLE/);
    expect(() => nativeHelperEnvironment({ home: '/fixture/home', codexHome: 'relative' })).toThrow(
      /VOICE_CODEX_UNAVAILABLE/,
    );
    expect(() => nativeHelperEnvironment({ home: '/fixture/\0' })).toThrow(
      /VOICE_CODEX_UNAVAILABLE/,
    );
  });
});
