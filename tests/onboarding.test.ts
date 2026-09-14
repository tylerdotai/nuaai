import { describe, expect, it } from 'vitest';

import { defaultRuntimeConfig, parseRuntimeConfig } from '../src/config/index.js';
import {
  applyOnboardingAnswers,
  localBootstrapArgs,
  tailscaleServeCommands,
} from '../src/onboarding.js';

describe('onboarding Tailscale routes', () => {
  it('persists the public /nuaai mount only when Tailscale Serve is selected', () => {
    const config = defaultRuntimeConfig('/tmp/nuaai-onboarding');
    expect(config.web.publicBasePath).toBe('/');
    const next = applyOnboardingAnswers(config, {
      ollama: true,
      codex: false,
      matrix: true,
      search: true,
      browser: true,
      tailscale: true,
      provider: 'ollama',
      launch: 'skip',
    });
    expect(next.web.publicBasePath).toBe('/nuaai');
    expect(() =>
      parseRuntimeConfig({ web: { publicBasePath: '/nuaai; SameSite=None' } }),
    ).toThrow();
  });

  it('keeps Matrix at the tailnet root and exposes NUAAI at /nuaai', () => {
    expect(tailscaleServeCommands('http://127.0.0.1:58657', 'http://127.0.0.1:45187')).toEqual([
      ['serve', '--bg', '58657'],
      ['serve', '--bg', '--set-path', '/nuaai', '45187'],
    ]);
  });

  it('rejects endpoints without explicit ports', () => {
    expect(() => tailscaleServeCommands('http://127.0.0.1', 'http://127.0.0.1:45187')).toThrow(
      'explicit port',
    );
  });
});

describe('modular local integration bootstrap', () => {
  it('requests only the integrations selected during onboarding', () => {
    expect(localBootstrapArgs({ matrix: true, search: false, browser: true })).toEqual([
      '--matrix',
      '--browser',
    ]);
    expect(localBootstrapArgs({ matrix: false, search: true, browser: false })).toEqual([
      '--search',
    ]);
    expect(localBootstrapArgs({ matrix: false, search: false, browser: false })).toEqual([]);
  });
});
