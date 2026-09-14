export const AUTH_REQUIRED_MESSAGE = 'Pair this device to continue.';
export const AUTH_EXPIRED_MESSAGE = 'Session expired — pair this device again.';
export const PAIRING_INVALID_MESSAGE =
  'Pairing link is invalid or expired — generate a new pairing link.';
export const PAIRING_FAILED_MESSAGE =
  'Pairing could not be completed — generate a new pairing link.';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function isRequestAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

export function pairingFailureMessage(error: unknown): string {
  return error instanceof ApiRequestError && error.code === 'PAIRING_INVALID'
    ? PAIRING_INVALID_MESSAGE
    : PAIRING_FAILED_MESSAGE;
}

export function isAuthenticationErrorMessage(message: string | null): boolean {
  return (
    message === AUTH_REQUIRED_MESSAGE ||
    message === AUTH_EXPIRED_MESSAGE ||
    message === PAIRING_INVALID_MESSAGE ||
    message === PAIRING_FAILED_MESSAGE
  );
}

export async function parseApiResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? ((await response.json()) as T & { error?: string; code?: string })
    : ({ error: await response.text() } as T & { error?: string; code?: string });
  if (!response.ok)
    throw new ApiRequestError(
      body.error ?? `Request failed: ${response.status}`,
      response.status,
      body.code,
    );
  return body;
}

export function webSocketCloseDisposition(
  code: number,
  reason: string,
): { reconnect: boolean; message?: string } {
  if (code !== 1008) return { reconnect: true };
  return {
    reconnect: false,
    message: reason === 'AUTH_EXPIRED' ? AUTH_EXPIRED_MESSAGE : AUTH_REQUIRED_MESSAGE,
  };
}
