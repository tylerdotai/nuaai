export const BOUND_PROFILE: 'bound-call-v1';
export const BOUND_FEATURE: 'synthetic-bound-call-tests';
export const BOUND_SOURCE_NAMES: string[];
export const PREPARED_CHECKS: string[];
export const BOUND_CASES: {
  name: string;
  ownerCurrent: boolean;
  recordedCalls: number;
  rotationAfterFreeze: boolean;
}[];
export function validateBoundManifest(manifest: unknown): {
  name: string;
  path: string;
  sha256: string;
  features: string[];
  build_argv: string[];
};
export function validateBoundAdmission(
  name: string,
  ownerCurrent: unknown,
  recordedCalls: unknown,
): (typeof BOUND_CASES)[number];
export function validateBoundEvidence(data: unknown, name: string): unknown;
