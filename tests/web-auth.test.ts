import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  ApiRequestError,
  PAIRING_FAILED_MESSAGE,
  PAIRING_INVALID_MESSAGE,
  isAuthenticationErrorMessage,
  isRequestAbort,
  pairingFailureMessage,
  parseApiResponse,
} from '../src/web/auth.js';
import { ErrorToast } from '../src/web/views.js';

describe('PWA authentication recovery', () => {
  it('preserves a structured expired-session response for the re-pair UI', async () => {
    const response = new Response(
      JSON.stringify({
        error: 'Session expired — pair this device again.',
        code: 'AUTH_EXPIRED',
      }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );

    await expect(parseApiResponse(response)).rejects.toEqual(
      new ApiRequestError('Session expired — pair this device again.', 401, 'AUTH_EXPIRED'),
    );
  });

  it('suppresses only expected request aborts from superseded selection loads', () => {
    expect(isRequestAbort(new DOMException('superseded', 'AbortError'))).toBe(true);
    const crossRealmAbort = new Error('signal is aborted without reason');
    crossRealmAbort.name = 'AbortError';
    expect(isRequestAbort(crossRealmAbort)).toBe(true);
    expect(isRequestAbort(new Error('network unavailable'))).toBe(false);
    expect(isRequestAbort('AbortError')).toBe(false);
  });

  it('presents re-pair guidance without a retry action that cannot repair authentication', () => {
    const markup = renderToStaticMarkup(
      createElement(ErrorToast, {
        title: 'Pair this device',
        error: 'Session expired — pair this device again.',
        onDismiss: vi.fn(),
      }),
    );

    expect(markup).toContain('Pair this device');
    expect(markup).toContain('Session expired — pair this device again.');
    expect(markup).not.toContain('>Retry<');
  });

  it('uses structured pairing codes and non-retryable guidance for failed exchanges', () => {
    expect(
      pairingFailureMessage(
        new ApiRequestError('Invalid or expired pairing token', 401, 'PAIRING_INVALID'),
      ),
    ).toBe(PAIRING_INVALID_MESSAGE);
    expect(pairingFailureMessage(new Error('network unavailable'))).toBe(PAIRING_FAILED_MESSAGE);
    expect(isAuthenticationErrorMessage(PAIRING_INVALID_MESSAGE)).toBe(true);
    expect(isAuthenticationErrorMessage(PAIRING_FAILED_MESSAGE)).toBe(true);
    expect(isAuthenticationErrorMessage('Provider unavailable')).toBe(false);
  });
});
