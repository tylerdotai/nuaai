import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenPayload {
  sub: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export type TokenInspection =
  | { status: 'valid'; payload: TokenPayload }
  | { status: 'expired'; payload: TokenPayload }
  | { status: 'invalid' };

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

export function inspectToken(token: string, secret: string, now = Date.now()): TokenInspection {
  if (!token || !secret) return { status: 'invalid' };

  const [body, signature] = token.split('.');
  if (!body || !signature) return { status: 'invalid' };

  const expected = sign(body, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  )
    return { status: 'invalid' };

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (!payload.sub || !Number.isFinite(payload.exp)) return { status: 'invalid' };
    if (payload.exp <= Math.floor(now / 1000)) return { status: 'expired', payload };
    return { status: 'valid', payload };
  } catch {
    return { status: 'invalid' };
  }
}

export function validateToken(
  token: string,
  secret: string,
  now = Date.now(),
): TokenPayload | null {
  const inspection = inspectToken(token, secret, now);
  return inspection.status === 'valid' ? inspection.payload : null;
}
