#!/usr/bin/env node
// Explicit Linux/x64 offline evidence runner. No Cargo, downloads, real stores or URLs.
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWithRegularStdio } from './regular-stdio.ts';

export const NORMAL_CASES = [
  'managed_same_owner',
  'no_auth',
  'stored_api_key',
  'stored_pat',
  'env_pat',
  'stored_agent_jwt',
  'env_agent_jwt',
  'managed_missing_token',
  'managed_invalid_bearer',
  'managed_missing_account',
  'managed_invalid_account_header',
  'managed_ab_account_switch',
  'managed_ab_user_switch',
  'managed_ab_login_owner_switch',
  'managed_ab_mode_switch',
  'managed_same_owner_token_rotation',
  'frozen_provider_after_store_drift',
  'managed_missing_user',
  'managed_missing_login_owner',
  'managed_free_plan',
  'managed_unknown_plan',
  'managed_ab_store_removed',
  'managed_idle_owner_switch',
];
export const FAULT_CASES = ['fault_unmanaged_factory_pat', 'fault_unmanaged_factory_agent'];
const PIN = '6aaac694803004a63c6f393d153c96d22521a6b9';
const SOURCE_NAMES = [
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
];
const HEADER_KEYS = [
  'bearer_present',
  'account_present',
  'account_matches_B',
  'token_matches_B',
  'unchanged_after_store_drift',
];
const ELIGIBLE = new Set(['managed_same_owner', 'managed_same_owner_token_rotation']);
const DRIFT = new Set(['frozen_provider_after_store_drift', 'managed_idle_owner_switch']);
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (value) => Object.keys(value).sort();
const exactKeys = (value, expected) =>
  check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      same(keys(value), expected.slice().sort()),
    'Unexpected evidence schema keys',
  );
const isSha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function hashFile(path) {
  check(statSync(path).isFile(), 'Fingerprint input must be a regular file');
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  try {
    for (;;) {
      const length = readSync(fd, buffer);
      if (!length) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

// The trace filter includes only network/uring plus these explicit non-network calls.
// Conservatively count every other traced syscall, not a hand-maintained network subset.
export function traceAttempts(trace) {
  return [...trace.matchAll(/^(\d+)\s+([A-Za-z0-9_]+)\(/gm)]
    .filter(([, , name]) => !['execve', 'execveat', 'close_range'].includes(name))
    .map(([, pid, syscall]) => ({ pid, syscall }));
}

export function tcpSocketAttempts(trace) {
  const number = '(0x[0-9a-f]+|[0-9]+)';
  const pattern = new RegExp(`^\\d+\\s+socket\\(${number},\\s*${number},\\s*${number}\\)`, 'gm');
  return [...trace.matchAll(pattern)]
    .map(([, domain, type, protocol]) => ({
      domain: Number(domain),
      type: Number(type),
      protocol: Number(protocol),
    }))
    .filter(
      (call) =>
        [2, 10].includes(call.domain) && (call.type & 15) === 1 && [0, 6].includes(call.protocol),
    );
}

export function decodeEvidence(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Native output is not valid JSON');
  }
}

export function validateEvidence(data, name, fault = false) {
  exactKeys(data, [
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
  ]);
  check((fault ? FAULT_CASES : NORMAL_CASES).includes(name), 'Unapproved native case');
  check(
    data.version === 1 &&
      data.case === name &&
      data.upstream_pin === PIN &&
      data.storage === 'file',
    'Invalid evidence identity',
  );
  check(
    data.content_constructed === false &&
      data.refresh_invoked === false &&
      data.freshness === 'not_validated',
    'Unexpected content/refresh/freshness claim',
  );
  check(data.auth_factory_guarded === !fault, 'Wrong auth factory mode');
  check(
    data.measurement === (fault ? 'fault_counterfactual' : 'normal_snapshot'),
    'Wrong measurement category',
  );
  const policy = fault ? 'unmanaged_fault_control' : 'unavailable';
  check(
    data.auth_policy_before === policy && data.auth_policy_after === policy,
    'Wrong direct policy state',
  );
  for (const key of ['stageA', 'stageB']) {
    check(
      ['managed', 'nonmanaged', 'none', 'native_error'].includes(data[key]),
      'Invalid stage category',
    );
  }
  exactKeys(data.owner_checks, ['a_current', 'b_current', 'after_drift']);
  exactKeys(data.header_checks, HEADER_KEYS);
  for (const value of [
    ...Object.values(data.owner_checks),
    ...Object.values(data.header_checks),
    data.manager_watch_changed_after_drift,
  ]) {
    check(value === null || typeof value === 'boolean', 'Non-boolean/sensitive evidence field');
  }
  check(
    data.result === (!fault && ELIGIBLE.has(name) ? 'eligible_frozen_snapshot' : 'rejected'),
    'Wrong local snapshot eligibility',
  );
  const pat = ['stored_pat', 'env_pat'].includes(name);
  const agent = ['stored_agent_jwt', 'env_agent_jwt'].includes(name);
  const witness =
    fault || name === 'managed_missing_token'
      ? 'unclassified_native_error'
      : pat
        ? 'pat_request_unavailable_message'
        : agent
          ? 'typed_unavailable'
          : null;
  check(data.bootstrap_witness_A === witness, 'Missing/wrong actual bootstrap witness');
  check(
    data.drift_measurement === (DRIFT.has(name) ? 'manual_persisted_owner_recheck' : null),
    'Wrong drift measurement claim',
  );
  if (fault || pat || agent || name === 'managed_missing_token') {
    check(
      data.stageA === 'native_error' && data.stageB === 'none',
      'Unexpected rejected-constructor categories',
    );
  } else if (name === 'no_auth') {
    check(data.stageA === 'none' && data.stageB === 'none', 'No-auth fixture was not absent');
  } else if (name === 'stored_api_key') {
    check(data.stageA === 'nonmanaged' && data.stageB === 'nonmanaged', 'API mode misclassified');
  } else {
    check(data.stageA === 'managed', 'Expected managed snapshot A');
    check(
      data.stageB ===
        (name === 'managed_ab_mode_switch'
          ? 'nonmanaged'
          : name === 'managed_ab_store_removed'
            ? 'none'
            : 'managed'),
      'Wrong snapshot B mode',
    );
  }
  if (ELIGIBLE.has(name)) {
    check(
      data.owner_checks.a_current === true && data.owner_checks.b_current === true,
      'Eligible pair lacks current owners',
    );
    check(
      HEADER_KEYS.slice(0, 4).every((key) => data.header_checks[key] === true),
      'Eligible pair lacks actual bound B headers',
    );
  }
  if (
    [
      'managed_ab_account_switch',
      'managed_ab_user_switch',
      'managed_ab_login_owner_switch',
      'managed_ab_mode_switch',
      'managed_ab_store_removed',
    ].includes(name)
  ) {
    check(data.owner_checks.a_current === false, 'Old A owner survived drift');
  }
  if (DRIFT.has(name)) {
    check(
      data.owner_checks.after_drift === false &&
        data.header_checks.unchanged_after_store_drift === true &&
        data.manager_watch_changed_after_drift === false,
      'Manual owner/cache-watch/frozen-header observation differs',
    );
  }
  if (name === 'managed_invalid_bearer') {
    check(data.header_checks.bearer_present === false, 'Invalid bearer was not omitted');
  }
  if (['managed_missing_account', 'managed_invalid_account_header'].includes(name)) {
    check(data.header_checks.account_present === false, 'Invalid account was not omitted');
  }
  return data; // Only fixed enums, booleans and null survive validation. No raw errors/headers.
}

function parseArgs(argv) {
  const names = [
    'normal-artifact',
    'fault-artifact',
    'provenance',
    'provenance-sha256',
    'canary',
    'canary-sha256',
    'output-dir',
  ];
  const result = {};
  check(argv.length === names.length * 2, 'Supply exactly the seven explicit runner options');
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index].slice(2);
    check(
      argv[index].startsWith('--') && names.includes(name) && !(name in result),
      'Unknown or duplicate runner option',
    );
    result[name] = argv[index + 1];
  }
  check(
    names.every((name) => typeof result[name] === 'string' && result[name].length > 0),
    'Missing explicit runner option',
  );
  check(
    isSha(result['provenance-sha256']) && isSha(result['canary-sha256']),
    'Trusted SHA256 values are mandatory',
  );
  return result;
}

export function run(argv) {
  const options = parseArgs(argv);
  check(process.platform === 'linux' && process.arch === 'x64', 'Linux/x64 only');
  check(
    hashFile(options.provenance) === options['provenance-sha256'],
    'Provenance digest differs from trusted approval',
  );
  const manifest = JSON.parse(readFileSync(options.provenance, 'utf8'));
  check(
    manifest.schema === 1 &&
      manifest.upstream_pin === PIN &&
      manifest.normal_cases === 23 &&
      same(manifest.fault_cases, FAULT_CASES),
    'Unsupported provenance contract',
  );
  exactKeys(manifest.sources, SOURCE_NAMES);
  check(
    manifest.compiler.version_verbose.startsWith('rustc 1.99.1 ') &&
      manifest.compiler.version_verbose.includes('host: x86_64-unknown-linux-gnu'),
    'Wrong compiler provenance',
  );
  check(
    Array.isArray(manifest.artifacts) && manifest.artifacts.length === 2,
    'Both explicit artifacts required',
  );
  const artifacts = Object.fromEntries(manifest.artifacts.map((entry) => [entry.name, entry]));
  exactKeys(artifacts, ['normal', 'fault-feature']);
  for (const [name, flag, feature] of [
    ['normal', 'normal-artifact', 'synthetic-auth-tests'],
    ['fault-feature', 'fault-artifact', 'synthetic-auth-faults'],
  ]) {
    const artifact = artifacts[name];
    check(
      resolve(artifact.path) === resolve(options[flag]) && same(artifact.features, [feature]),
      'Artifact path/features differ from trusted provenance',
    );
    check(
      same(artifact.build_argv, [
        'cargo',
        '+1.99.1',
        'build',
        '--offline',
        '--locked',
        '--features',
        feature,
        '--manifest-path',
        'native/voice-probe/Cargo.toml',
        '--bin',
        'synthetic-auth-probe',
        '--jobs',
        '2',
      ]),
      'Unexpected build argv',
    );
  }
  for (const [name, entry] of Object.entries(manifest.sources)) {
    check(
      resolve(entry.path) === resolve(manifest.root, 'native/voice-probe', name),
      'Source path differs from approved source tree',
    );
  }
  const inputs = [
    ...Object.values(manifest.sources),
    manifest.compiler,
    ...manifest.artifacts,
    { path: options.provenance, sha256: options['provenance-sha256'] },
    { path: options.canary, sha256: options['canary-sha256'] },
  ];
  const verify = () => {
    for (const entry of inputs)
      check(
        isSha(entry.sha256) && hashFile(entry.path) === entry.sha256,
        'Frozen provenance input changed; STOP before execution',
      );
  };
  verify(); // No temporary home, tracer, compiler, or native executable before full verification.
  const output = resolve(options['output-dir']);
  mkdirSync(output, { mode: 0o700 }); // Must be a NEW private directory; never overwrite prior evidence.
  const records = [];
  let complete = false;
  let activeCase = 'canary';
  let lastNetworkAttempts = null;
  const write = (name, value) =>
    writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  function launch(artifact, name, nativeArgs, fault = false, canary = false) {
    const home = mkdtempSync(join(output, 'fixture-'));
    try {
      const tracePath = join(output, `${name}.strace`);
      const args = [
        '--kill-on-exit',
        '-f',
        '-qq',
        '-e',
        'trace=%network,io_uring_setup,io_uring_enter,io_uring_register,execve,execveat,close_range',
        '-e',
        'raw=all',
        '--inject=%network,io_uring_setup,io_uring_enter,io_uring_register:error=EPERM',
        '-o',
        tracePath,
        artifact,
        ...nativeArgs,
      ];
      const env = { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: home, TMPDIR: home };
      if (canary) env.CANARY_SYNTHETIC_HOME = home;
      else env.NUAAI_SYNTHETIC_AUTH_FENCED = '1';
      if (fault) env.NUAAI_SYNTHETIC_AUTH_FAULT_FENCED = '1';
      const child = runWithRegularStdio('/usr/bin/strace', args, {
        stdoutPath: join(output, `${name}.stdout`),
        stderrPath: join(output, `${name}.stderr`),
        cwd: home,
        env,
        timeout: 20_000,
        killSignal: 'SIGTERM',
        maxBuffer: 65_536,
      });
      check(!child.error && child.signal === null, 'Owned tracer/child failed or timed out');
      const trace = readFileSync(tracePath, 'utf8');
      const attempts = traceAttempts(trace);
      return { child, trace, attempts };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  write('approved-provenance.json', manifest); // Metadata only, never a copy of auth source/store contents.
  try {
    const canary = launch(options.canary, 'canary', [], false, true);
    check(
      canary.child.status === 0 &&
        canary.child.stderr === '' &&
        canary.child.stdout ===
          'CANARY_CHILD_EXPECTED_INJECTION_OK\nCANARY_PARENT_EXPECTED_INJECTION_OK processes=2 attempts=16\n',
      'Canary did not prove the owned-child fence',
    );
    check(
      canary.attempts.length === 16 &&
        new Set(canary.attempts.map((call) => call.pid)).size === 2 &&
        (canary.trace.match(/\(INJECTED\)/g) ?? []).length === 16 &&
        canary.trace
          .split('\n')
          .filter((line) => line.includes('(INJECTED)'))
          .every((line) => line.includes('EPERM')),
      'Wrong canary interception/follow-descendant evidence',
    );
    write('canary.json', { state: 'GREEN safety-belt-only', injected: 16, processes: 2 });
    verify();
    for (const name of NORMAL_CASES) {
      activeCase = name;
      const observed = launch(artifacts.normal.path, name, ['--case', name]);
      lastNetworkAttempts = observed.attempts.length;
      check(
        observed.attempts.length === 0 && !observed.trace.includes('(INJECTED)'),
        'Native zero-attempt assertion FAILED; injected EPERM is NOT a policy pass',
      );
      check(
        observed.child.status === 0 && observed.child.stderr === '',
        'Native case did not complete',
      );
      check(observed.trace.includes('close_range('), 'Native descriptor guard not observed');
      const data = validateEvidence(decodeEvidence(observed.child.stdout), name);
      write(`${name}.json`, data);
      records.push({ case: name, artifact: 'normal', state: 'PASS', networkAttempts: 0 });
      console.log(`${name}: PASS; native network attempts=0`);
    }
    verify();
    // These are deliberately FAILED native-zero-attempt assertions, never normal green cases.
    for (const name of FAULT_CASES) {
      activeCase = name;
      const observed = launch(artifacts['fault-feature'].path, name, ['--case', name], true);
      lastNetworkAttempts = observed.attempts.length;
      check(
        observed.child.status === 0 && observed.child.stderr === '',
        'Fault fixture did not complete',
      );
      const tcpAttempts = tcpSocketAttempts(observed.trace);
      check(tcpAttempts.length > 0, 'Fault bootstrap unproved: no native TCP socket attempt');
      check(
        (observed.trace.match(/\(INJECTED\)/g) ?? []).length === observed.attempts.length &&
          observed.trace
            .split('\n')
            .filter((line) => line.includes('(INJECTED)'))
            .every((line) => line.includes('EPERM')),
        'Fault attempt escaped the denial belt',
      );
      const data = validateEvidence(decodeEvidence(observed.child.stdout), name, true);
      write(`${name}.json`, data);
      records.push({
        case: name,
        artifact: 'fault-feature',
        state: 'EXPECTED_RED_NATIVE_ZERO_ATTEMPT_ASSERTION',
        networkAttempts: observed.attempts.length,
        tcpSocketAttempts: tcpAttempts.length,
        injected: observed.attempts.length,
      });
      console.log(`${name}: EXPECTED RED; native zero-attempt assertion FAILED safely`);
    }
    verify();
    complete = true;
  } finally {
    // Preserve post-stop provenance even on the first failed native assertion.
    let provenanceStableAfter = true;
    try {
      verify();
    } catch {
      provenanceStableAfter = false;
    }
    write('summary.json', {
      state:
        complete && provenanceStableAfter
          ? 'COMPLETE bounded synthetic observations'
          : 'STOPPED/INCOMPLETE',
      activeCase,
      lastNetworkAttempts,
      provenanceStableAfter,
      provenanceSha256: options['provenance-sha256'],
      canarySha256: options['canary-sha256'],
      normalPassed: records.filter((record) => record.state === 'PASS').length,
      faultExpectedRed: records.filter((record) => record.state.startsWith('EXPECTED_RED')).length,
      records,
      limitations: [
        'No filesystem namespace/general malicious-binary sandbox',
        'PAT request-site message is lossy, paired with separate fault trace; not a typed cause',
        'Manual persisted-owner recheck is not idle/atomic revocation or transport close',
        'No content/401/freshness/WS/helper/daemon/provider/entitlement/mic acceptance',
      ],
    });
    check(
      provenanceStableAfter,
      'Frozen provenance changed during the batch; evidence is incomplete',
    );
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    // Fixed diagnostics only; never dump raw child responses, error chains or header values.
    console.error(
      `Synthetic evidence STOP: ${error instanceof Error ? error.message : 'invalid evidence'}`,
    );
    process.exitCode = 1;
  }
}
