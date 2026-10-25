import { describe, expect, it } from 'vitest';
import {
  BOUND_CASES,
  BOUND_FEATURE,
  BOUND_SOURCE_NAMES,
  PREPARED_CHECKS,
  validateBoundEvidence,
  validateBoundManifest,
} from './bound-call-profile.mjs';

function evidence(name: string) {
  const expected = BOUND_CASES.find((entry) => entry.name === name);
  if (!expected) throw new Error('Unknown test case');
  const creates = expected.recordedCalls === 1;
  return {
    version: 2,
    case: name,
    upstream_pin: '6aaac694803004a63c6f393d153c96d22521a6b9',
    storage: 'file',
    auth_policy_before: 'unavailable',
    auth_policy_after: 'unavailable',
    stageA: 'managed',
    stageB: 'managed',
    owner_checks: { a_current: true, b_current: true, after_drift: null },
    header_checks: {
      bearer_present: true,
      account_present: true,
      account_matches_B: true,
      token_matches_B: true,
      unchanged_after_store_drift: null,
    },
    manager_watch_changed_after_drift: null,
    drift_measurement: null,
    bootstrap_witness_A: null,
    measurement: 'native_bound_call',
    auth_factory_guarded: true,
    result: creates ? 'create_recorded' : 'owner_rejected',
    content_constructed: creates,
    refresh_invoked: false,
    freshness: 'not_validated',
    bound_request: {
      owner_current_before_create: expected.ownerCurrent,
      admission_denied: !creates,
      call_client_constructed: creates,
      transport_executions: expected.recordedCalls,
      ...Object.fromEntries(PREPARED_CHECKS.map((key) => [key, creates ? true : null])),
      response_valid: creates,
    },
  };
}

function manifest() {
  return {
    schema: 1,
    profile: 'bound-call-v1',
    candidate_stage: 'owner_admission_red',
    cases: BOUND_CASES.map((entry) => entry.name),
    argv: ['--case', '<fixed-name>'],
    required_markers: ['NUAAI_SYNTHETIC_AUTH_FENCED=1'],
    upstream_pin: '6aaac694803004a63c6f393d153c96d22521a6b9',
    root: '/synthetic',
    sources: Object.fromEntries(
      BOUND_SOURCE_NAMES.map((name) => [
        name,
        {
          path: `/synthetic/native/voice-probe/${name}`,
          sha256: '0'.repeat(64),
        },
      ]),
    ),
    compiler: {
      path: '/synthetic/rustc',
      sha256: '0'.repeat(64),
      version_verbose: 'rustc 1.99.1 fixture\nhost: x86_64-unknown-linux-gnu',
    },
    artifacts: [
      {
        name: 'bound-call',
        path: '/synthetic/artifact',
        sha256: '0'.repeat(64),
        features: [BOUND_FEATURE],
        build_argv: [
          'cargo',
          '+1.99.1',
          'build',
          '--offline',
          '--locked',
          '--features',
          BOUND_FEATURE,
          '--manifest-path',
          'native/voice-probe/Cargo.toml',
          '--bin',
          'synthetic-auth-probe',
          '--jobs',
          '2',
        ],
      },
    ],
  };
}

describe('strict native bound-call evidence profile (pure fixtures only)', () => {
  it.each(BOUND_CASES)('accepts the exact $name contract', ({ name }) => {
    expect(validateBoundEvidence(evidence(name), name)).toEqual(evidence(name));
  });

  it('does not relax zero execution for the deliberately missing-owner-guard RED', () => {
    const name = 'bound_owner_drift_before_create';
    const red = evidence(name);
    red.bound_request.transport_executions = 1;
    red.bound_request.admission_denied = false;
    red.bound_request.call_client_constructed = true;
    expect(() => validateBoundEvidence(red, name)).toThrow('execution count must equal 0');
  });

  it('rejects every false prepared B/header/body observation', () => {
    const name = 'bound_create_uses_B';
    for (const key of PREPARED_CHECKS) {
      const data = evidence(name);
      const mutated = { ...data, bound_request: { ...data.bound_request, [key]: false } };
      expect(() => validateBoundEvidence(mutated, name)).toThrow('prepared native request');
    }
  });

  it('requires null prepared facts when transport never executed', () => {
    const name = 'bound_owner_drift_before_create';
    const data = evidence(name);
    expect(() =>
      validateBoundEvidence(
        { ...data, bound_request: { ...data.bound_request, prepared_bearer_matches_B: false } },
        name,
      ),
    ).toThrow('prepared native request');
  });

  it('rejects sensitive extra fields, old aliases and non-current A/B setup', () => {
    const name = 'bound_create_uses_B';
    expect(() =>
      validateBoundEvidence({ ...evidence(name), raw_header: 'forbidden' }, name),
    ).toThrow('schema');
    expect(() => validateBoundEvidence(evidence(name), 'bound_rotated_b_create')).toThrow(
      'identity',
    );
    const data = evidence(name);
    data.owner_checks.a_current = false;
    expect(() => validateBoundEvidence(data, name)).toThrow('actual initial current A/B');
  });

  it('requires explicit twelve-source provenance and exact feature/build/case selection', () => {
    const good = manifest();
    expect(validateBoundManifest(good)).toEqual(good.artifacts[0]);
    for (const bad of [
      { ...good, profile: undefined },
      { ...good, sources: { ...good.sources, extra: good.sources['Cargo.toml'] } },
      { ...good, cases: ['bound_rotated_b_create'] },
      { ...good, artifacts: [{ ...good.artifacts[0], features: ['synthetic-auth-faults'] }] },
      { ...good, artifacts: [{ ...good.artifacts[0], build_argv: ['cargo', 'build'] }] },
    ])
      expect(() => validateBoundManifest(bad)).toThrow();
  });
});
