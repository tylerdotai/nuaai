// Explicit new source/provenance profile. The archived eleven-source auth runner is unchanged.
// Source preparation only: this module never builds, opens files, or invokes native code.
import { isAbsolute, resolve } from 'node:path';

export const BOUND_PROFILE = 'bound-call-v1';
export const BOUND_FEATURE = 'synthetic-bound-call-tests';
export const BOUND_SOURCE_NAMES = [
  '.gitignore',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'README.md',
  'check-graph.mjs',
  'check-graph.test.mjs',
  'src/lib.rs',
  'src/main.rs',
  'src/auth_guard.rs',
  'src/bin/synthetic_auth_probe.rs',
  'src/bound_call.rs',
];

export const BOUND_CASES = [
  { name: 'bound_create_uses_B', ownerCurrent: true, recordedCalls: 1, rotationAfterFreeze: false },
  {
    name: 'bound_owner_drift_before_create',
    ownerCurrent: false,
    recordedCalls: 0,
    rotationAfterFreeze: false,
  },
  {
    name: 'bound_frozen_B_after_rotation',
    ownerCurrent: true,
    recordedCalls: 1,
    rotationAfterFreeze: true,
  },
];

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validateBoundManifest(manifest) {
  check(
    manifest?.schema === 1 && manifest.profile === BOUND_PROFILE,
    'An explicit bound-call-v1 provenance profile is required',
  );
  check(
    ['owner_admission_red', 'guarded'].includes(manifest.candidate_stage) &&
      same(
        manifest.cases,
        BOUND_CASES.map((entry) => entry.name),
      ) &&
      same(manifest.argv, ['--case', '<fixed-name>']) &&
      same(manifest.required_markers, ['NUAAI_SYNTHETIC_AUTH_FENCED=1']),
    'Unexpected bound-call candidate/case/entry profile',
  );
  check(
    manifest.upstream_pin === '6aaac694803004a63c6f393d153c96d22521a6b9',
    'Unexpected bound-call source pin',
  );
  check(
    typeof manifest.root === 'string' && isAbsolute(manifest.root),
    'Bound-call source root must be explicit',
  );
  check(
    manifest.sources &&
      same(Object.keys(manifest.sources).sort(), BOUND_SOURCE_NAMES.slice().sort()),
    'Bound-call profile requires exactly its twelve reviewed sources',
  );
  for (const name of BOUND_SOURCE_NAMES) {
    const entry = manifest.sources[name];
    check(
      typeof entry?.path === 'string' &&
        resolve(entry.path) === resolve(manifest.root, 'native/voice-probe', name) &&
        isDigest(entry.sha256),
      'Invalid bound-call source provenance entry',
    );
  }
  check(
    typeof manifest.compiler?.path === 'string' &&
      isDigest(manifest.compiler.sha256) &&
      manifest.compiler.version_verbose?.startsWith('rustc 1.99.1 ') &&
      manifest.compiler.version_verbose.includes('host: x86_64-unknown-linux-gnu'),
    'Unexpected bound-call compiler provenance',
  );
  check(
    Array.isArray(manifest.artifacts) && manifest.artifacts.length === 1,
    'Bound-call profile requires one explicit artifact',
  );
  const artifact = manifest.artifacts[0];
  check(
    artifact.name === 'bound-call' &&
      typeof artifact.path === 'string' &&
      isDigest(artifact.sha256) &&
      same(artifact.features, [BOUND_FEATURE]),
    'Wrong bound-call artifact or feature selection',
  );
  check(
    same(artifact.build_argv, [
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
    ]),
    'Unexpected bound-call build argv',
  );
  return artifact;
}

// The missing-owner-guard RED candidate must fail THIS SAME zero-call contract.
// Never change this expectation to one based on a candidate-stage/RED flag.
export function validateBoundAdmission(name, ownerCurrent, recordedCalls) {
  const expected = BOUND_CASES.find((entry) => entry.name === name);
  check(expected, 'Unknown bound-call case');
  check(ownerCurrent === expected.ownerCurrent, 'Wrong persisted owner observation');
  check(
    Number.isInteger(recordedCalls) && recordedCalls === expected.recordedCalls,
    `Bound transport execution count must equal ${expected.recordedCalls}`,
  );
  return expected;
}

export const PREPARED_CHECKS = [
  'prepared_bearer_matches_B',
  'prepared_account_matches_B',
  'prepared_bearer_not_A',
  'prepared_bearer_not_C',
  'prepared_auth_count_one',
  'prepared_account_count_one',
  'prepared_content_type_json',
  'prepared_body_is_native_v3',
];

export function validateBoundEvidence(data, name) {
  const sameKeys = (value, expected) =>
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    same(Object.keys(value).sort(), expected.slice().sort());
  check(
    sameKeys(data, [
      'version',
      'case',
      'upstream_pin',
      'storage',
      'auth_policy_before',
      'auth_policy_after',
      'stageA',
      'stageB',
      'owner_checks',
      'header_checks',
      'manager_watch_changed_after_drift',
      'drift_measurement',
      'bootstrap_witness_A',
      'measurement',
      'auth_factory_guarded',
      'result',
      'content_constructed',
      'refresh_invoked',
      'freshness',
      'bound_request',
    ]),
    'Unexpected bound-call evidence schema',
  );
  check(
    data.version === 2 &&
      data.case === name &&
      data.measurement === 'native_bound_call' &&
      data.upstream_pin === '6aaac694803004a63c6f393d153c96d22521a6b9' &&
      data.storage === 'file',
    'Wrong bound-call evidence identity',
  );
  check(
    data.auth_policy_before === 'unavailable' &&
      data.auth_policy_after === 'unavailable' &&
      data.auth_factory_guarded === true &&
      data.refresh_invoked === false &&
      data.freshness === 'not_validated',
    'Unexpected bound-call auth/refresh claim',
  );
  check(
    data.stageA === 'managed' && data.stageB === 'managed' && data.bootstrap_witness_A === null,
    'Bound-call requires actual managed A/B snapshots',
  );
  check(
    sameKeys(data.owner_checks, ['a_current', 'b_current', 'after_drift']),
    'Wrong bound-call owner schema',
  );
  const headerKeys = [
    'bearer_present',
    'account_present',
    'account_matches_B',
    'token_matches_B',
    'unchanged_after_store_drift',
  ];
  check(sameKeys(data.header_checks, headerKeys), 'Wrong bound-call header schema');
  for (const value of [
    ...Object.values(data.owner_checks),
    ...Object.values(data.header_checks),
    data.manager_watch_changed_after_drift,
  ]) {
    check(value === null || typeof value === 'boolean', 'Sensitive/non-boolean bound-call field');
  }
  check(
    data.owner_checks.a_current === true &&
      data.owner_checks.b_current === true &&
      data.owner_checks.after_drift === null &&
      data.manager_watch_changed_after_drift === null &&
      data.header_checks.unchanged_after_store_drift === null,
    'Bound-call setup must retain actual initial current A/B observations without legacy drift',
  );
  check(
    headerKeys.slice(0, 4).every((key) => data.header_checks[key] === true),
    'Bound-call preflight lacks actual complete B header pair',
  );
  check(
    data.drift_measurement === null,
    'Do not mix legacy manual-drift case with bound admission',
  );
  const bound = data.bound_request;
  check(
    sameKeys(bound, [
      'owner_current_before_create',
      'admission_denied',
      'call_client_constructed',
      'transport_executions',
      ...PREPARED_CHECKS,
      'response_valid',
    ]),
    'Unexpected actual bound-request evidence schema',
  );
  // Check measured count BEFORE outcome flags: the RED candidate must fail at 1 versus 0.
  const expected = validateBoundAdmission(
    name,
    bound.owner_current_before_create,
    bound.transport_executions,
  );
  const creates = expected.recordedCalls === 1;
  check(
    bound.admission_denied === !creates &&
      bound.call_client_constructed === creates &&
      data.content_constructed === creates &&
      bound.response_valid === creates,
    'Wrong bound-call admission/client/response facts',
  );
  check(
    data.result === (creates ? 'create_recorded' : 'owner_rejected'),
    'Wrong bound-call result',
  );
  check(
    PREPARED_CHECKS.every((key) => bound[key] === (creates ? true : null)),
    'Actual prepared native request is not the unique frozen B pair/native V3 body',
  );
  // A/C account ids may equal B. Bearer inequality plus account equality proves pair inequality.
  return data;
}
