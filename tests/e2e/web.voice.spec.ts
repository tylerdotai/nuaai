import { type Page, expect, test } from '@playwright/test';
import { createBrowserPairingToken } from '../../src/gateway/runtime.js';
import { type VoiceCapabilities, voiceLimits } from '../../src/voice/types.js';

const capability: VoiceCapabilities = {
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
};
async function openVoice(page: Page): Promise<void> {
  const root = process.env.NUAAI_E2E_ROOT;
  if (!root) throw new Error('An isolated E2E root is required');
  await page.goto(`/nuaai/#token=${encodeURIComponent(createBrowserPairingToken(root))}`);
  await expect(page.locator('.connection')).toContainText('Connected');
  await page.locator('.new-conversation-button').click();
  await expect(page.locator('.connection')).toContainText('New conversation ready');
  await page.locator('.voice-panel summary').click();
}

test('unavailable subscription voice shows the isolation blocker without capture, peer creation, or provider start', async ({
  page,
}) => {
  let starts = 0;
  await page.addInitScript(() => {
    const fixture = window as unknown as { captureCount: number; peerCount: number };
    fixture.captureCount = 0;
    fixture.peerCount = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      fixture.captureCount += 1;
      throw new Error('No device activation allowed');
    };
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor() {
        super();
        fixture.peerCount += 1;
      }
    };
  });
  await page.route('**/api/voice/capabilities', (route) =>
    route.fulfill({
      json: {
        ...capability,
        available: false,
        blockers: [
          {
            code: 'VOICE_EXECUTION_ISOLATION_UNVERIFIED',
            message: 'Installed Codex cannot prevent backing-thread tool execution.',
            retryable: false,
            stage: 'preflight',
          },
        ],
      },
    }),
  );
  await page.route('**/api/voice/sessions', (route) => {
    starts += 1;
    return route.abort();
  });
  await openVoice(page);
  const panel = page.getByLabel('Foreground voice');
  await expect(panel.getByRole('alert')).toContainText(
    'cannot prevent backing-thread tool execution',
  );
  await expect(panel.getByRole('button', { name: 'Start voice', exact: true })).toBeDisabled();
  await expect(panel.locator('summary')).toContainText('unavailable');
  expect(
    await page.evaluate(() => {
      const fixture = window as unknown as { captureCount: number; peerCount: number };
      return [fixture.captureCount, fixture.peerCount];
    }),
  ).toEqual([0, 0]);
  expect(starts).toBe(0);
  await expect(page.getByPlaceholder('Message NUAAI…')).toBeEnabled();
});

for (const [code, guidance] of [
  ['VOICE_CODEX_LOGIN_REQUIRED', 'existing Codex/ChatGPT sign-in'],
  ['VOICE_QUOTA_EXCEEDED', 'voice quota'],
] as const) {
  test(`live subscription ${code} is actionable and cleans synthetic capture without automatic retry`, async ({
    page,
  }) => {
    let starts = 0;
    await page.route('**/api/voice/capabilities', (route) =>
      route.fulfill({
        json: { ...capability, interruption: 'unsupported' },
      }),
    );
    await page.route('**/api/voice/sessions', (route) => {
      starts += 1;
      return route.fulfill({
        status: 503,
        json: {
          error: { code, message: 'PRIVATE_UPSTREAM_DETAILS', retryable: false, stage: 'start' },
        },
      });
    });
    await page.addInitScript(() => {
      const fixture = { captures: 0, stopped: 0, peersClosed: 0, channelsClosed: 0 };
      Object.assign(window, { liveVoiceFixture: fixture });
      const track = {
        enabled: true,
        onended: null,
        stop: () => {
          fixture.stopped += 1;
        },
      };
      navigator.mediaDevices.getUserMedia = async () =>
        ({
          getTracks: () => [track],
          getAudioTracks: () => [track],
        }) as unknown as MediaStream;
      const capture = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        fixture.captures += 1;
        return capture(constraints);
      };
      window.RTCPeerConnection = class {
        connectionState = 'new';
        iceGatheringState = 'complete';
        localDescription = { type: 'offer', sdp: 'synthetic-ui-offer' };
        createDataChannel() {
          return {
            onclose: null,
            onerror: null,
            close: () => {
              fixture.channelsClosed += 1;
            },
          };
        }
        addTrack() {}
        async createOffer() {
          return this.localDescription;
        }
        async setLocalDescription() {}
        async setRemoteDescription() {}
        close() {
          fixture.peersClosed += 1;
        }
      } as unknown as typeof RTCPeerConnection;
    });
    await openVoice(page);
    const panel = page.getByLabel('Foreground voice');
    await expect(panel.getByText(/Speech interruption is unsupported/)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Interrupt speech', exact: true })).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { liveVoiceFixture: { captures: number } }).liveVoiceFixture
            .captures,
      ),
    ).toBe(0);
    expect(starts).toBe(0);
    await panel.getByRole('button', { name: 'Start voice', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText(guidance);
    await expect(panel.getByRole('alert')).not.toContainText('PRIVATE_UPSTREAM_DETAILS');
    await expect(panel.getByRole('status')).toContainText('Microphone: ended');
    await expect(panel.getByRole('status')).toContainText('Transport: closed');
    expect(
      await page.evaluate(
        () => (window as unknown as { liveVoiceFixture: Record<string, number> }).liveVoiceFixture,
      ),
    ).toEqual({
      captures: 1,
      stopped: 1,
      peersClosed: 1,
      channelsClosed: 1,
    });
    await panel.getByRole('button', { name: 'Check voice availability', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Start voice', exact: true })).toBeEnabled();
    expect(starts).toBe(1);
    await expect(page.getByPlaceholder('Message NUAAI…')).toBeEnabled();
  });
}

for (const exit of ['hangup', 'hidden', 'pagehide', 'session', 'thread', 'view'] as const) {
  test(`${exit} while permission is pending releases late synthetic input without creating a peer or admitting work`, async ({
    page,
  }) => {
    let starts = 0;
    let cancellations = 0;
    await page.route('**/api/voice/capabilities', (route) => route.fulfill({ json: capability }));
    await page.route('**/api/voice/sessions', (route) => {
      starts += 1;
      return route.abort();
    });
    page.on('request', (request) => {
      if (request.url().includes('/cancel')) cancellations += 1;
    });
    await page.addInitScript(() => {
      const fixture = window as unknown as {
        captureCount: number;
        peerCount: number;
        resolveCapture: (stream: MediaStream) => void;
        track?: MediaStreamTrack;
        context?: AudioContext;
      };
      fixture.captureCount = 0;
      fixture.peerCount = 0;
      navigator.mediaDevices.getUserMedia = () => {
        fixture.captureCount += 1;
        return new Promise((resolve) => {
          fixture.resolveCapture = resolve;
        });
      };
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer {
        constructor() {
          super();
          fixture.peerCount += 1;
        }
      };
    });
    await openVoice(page);
    const panel = page.getByLabel('Foreground voice');
    const start = panel.getByRole('button', { name: 'Start voice', exact: true });
    await expect(start).toBeEnabled();
    expect(
      await start.evaluate((button) => button.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => (window as unknown as { captureCount: number }).captureCount),
    ).toBe(0);
    await start.focus();
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('status')).toContainText('requesting-mic');
    if (exit === 'hangup')
      await panel.getByRole('button', { name: 'Hang up', exact: true }).click();
    else if (exit === 'hidden')
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    else if (exit === 'pagehide')
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    else if (exit === 'session') await page.locator('.new-conversation-button').click();
    else if (exit === 'thread')
      await page.getByRole('button', { name: 'New thread', exact: true }).click();
    else await page.getByRole('tab', { name: 'System', exact: true }).click();
    if (['hangup', 'hidden', 'pagehide'].includes(exit))
      await expect(panel.getByRole('status')).toContainText('ended');
    else await expect(page.getByText(/Voice: requesting-mic/)).toHaveCount(0);
    await page.evaluate(() => {
      const fixture = window as unknown as {
        resolveCapture: (stream: MediaStream) => void;
        track: MediaStreamTrack;
        context: AudioContext;
      };
      // Synthetic input only. This never queries or activates a physical microphone.
      fixture.context = new AudioContext();
      const destination = fixture.context.createMediaStreamDestination();
      fixture.track = destination.stream.getAudioTracks()[0];
      fixture.resolveCapture(destination.stream);
    });
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { track: MediaStreamTrack }).track.readyState),
      )
      .toBe('ended');
    expect(await page.evaluate(() => (window as unknown as { peerCount: number }).peerCount)).toBe(
      0,
    );
    expect(starts).toBe(0);
    expect(cancellations).toBe(0);
    if (['hangup', 'hidden', 'pagehide'].includes(exit))
      await expect(panel.getByRole('status')).toContainText('ended');
    await page.evaluate(() => (window as unknown as { context: AudioContext }).context.close());
  });
}
