#!/usr/bin/env node

const baseUrl = (process.env.NUAAI_BASE_URL ?? 'http://127.0.0.1:45187').replace(/\/$/, '');

async function request(path) {
  try {
    return await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(
      `${path} request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const health = await request('/health');
if (!health.ok) throw new Error(`/health returned HTTP ${health.status}`);
const healthBody = await health.json();
if (healthBody.ok !== true || healthBody.daemon !== true)
  throw new Error('/health did not report an active daemon');

const protectedRoute = await request('/api/status');
if (protectedRoute.status !== 401)
  throw new Error(
    `/api/status returned HTTP ${protectedRoute.status}; expected unauthenticated rejection`,
  );

console.log(`NUAAI daemon healthy at ${baseUrl}`);
console.log('Protected API rejects unauthenticated requests (HTTP 401)');
