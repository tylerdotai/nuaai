import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenPayload {
  sub: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function createToken(
  payload: Omit<TokenPayload, 'iat'> & Partial<Pick<TokenPayload, 'iat'>>,
  secret: string,
  now = Date.now(),
): string {
  if (!secret) {
    throw new Error('Token secret is required');
  }

  const body = encode(JSON.stringify({ ...payload, iat: payload.iat ?? Math.floor(now / 1000) }));
  return `${body}.${sign(body, secret)}`;
}

export function validateToken(
  token: string,
  secret: string,
  now = Date.now(),
): TokenPayload | null {
  if (!token || !secret) {
    return null;
  }

  const [body, signature] = token.split('.');
  if (!body || !signature) {
    return null;
  }

  const expected = sign(body, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (!payload.sub || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(now / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
