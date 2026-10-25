#!/usr/bin/env node
// Separate twelve-source profile. Never edits/reuses the archived eleven-source execution mode.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BOUND_CASES,
  validateBoundEvidence,
  validateBoundManifest,
} from './bound-call-profile.mjs';
import { runWithRegularStdio } from './regular-stdio.ts';
import {
  NORMAL_CASES,
  decodeEvidence,
  hashFile,
  traceAttempts,
  validateEvidence,
} from './run-synthetic-auth.mjs';
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function run(argv) {
  const names = [
    'artifact',
    'provenance',
    'provenance-sha256',
    'canary',
    'canary-sha256',
    'output-dir',
  ];
  check(argv.length === names.length * 2, 'Supply exactly six explicit bound-call runner options');
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].slice(2);
    check(
      argv[i].startsWith('--') && names.includes(name) && !(name in options),
      'Unknown/duplicate bound-call option',
    );
    options[name] = argv[i + 1];
  }
  check(
    names.every((name) => typeof options[name] === 'string' && options[name].length > 0),
    'Missing bound-call option',
  );
  check(process.platform === 'linux' && process.arch === 'x64', 'Linux/x64 only');
  check(
    digest(options['provenance-sha256']) && digest(options['canary-sha256']),
    'Explicit approved digests required',
  );
  check(
    hashFile(options.provenance) === options['provenance-sha256'],
    'Unapproved bound-call manifest',
  );
  const manifest = JSON.parse(readFileSync(options.provenance, 'utf8'));
  const artifact = validateBoundManifest(manifest);
  check(
    resolve(artifact.path) === resolve(options.artifact),
    'Artifact differs from approved profile',
  );
  const inputs = [
    ...Object.values(manifest.sources),
    manifest.compiler,
    artifact,
    { path: options.provenance, sha256: options['provenance-sha256'] },
    { path: options.canary, sha256: options['canary-sha256'] },
  ];
  // Archive comparison is additional to (never a substitute for) current source coherence.
  if (manifest.source_archive) {
    for (const [name, entry] of Object.entries(manifest.sources))
      inputs.push({ path: join(manifest.source_archive, name), sha256: entry.sha256 });
  }
  const verify = () => {
    for (const input of inputs)
      check(
        digest(input.sha256) && hashFile(input.path) === input.sha256,
        'Frozen bound-call input changed; STOP',
      );
  };
  verify(); // Before any home, tracer or native executable.
  const output = resolve(options['output-dir']);
  mkdirSync(output, { mode: 0o700 });
  const write = (name, data) =>
    writeFileSync(join(output, name), `${JSON.stringify(data, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  const records = [];
  let activeCase = 'canary';
  let lastObservation = null;
  let complete = false;
  function launch(path, name, nativeArgs, canary = false) {
    const home = mkdtempSync(join(output, 'fixture-'));
    try {
      const tracePath = join(output, `${name}.strace`);
      const env = { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: home, TMPDIR: home };
      if (canary) env.CANARY_SYNTHETIC_HOME = home;
      else env.NUAAI_SYNTHETIC_AUTH_FENCED = '1';
      const child = runWithRegularStdio(
        '/usr/bin/strace',
        [
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
          path,
          ...nativeArgs,
        ],
        {
          stdoutPath: join(output, `${name}.stdout`),
          stderrPath: join(output, `${name}.stderr`),
          cwd: home,
          env,
          timeout: 20_000,
          killSignal: 'SIGTERM',
          maxBuffer: 65_536,
        },
      );
      check(!child.error && child.signal === null, 'Owned bound-call tracer failed/timed out');
      const trace = readFileSync(tracePath, 'utf8');
      return { child, trace, attempts: traceAttempts(trace) };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  write('approved-provenance.json', manifest);
  try {
    const canary = launch(options.canary, 'canary', [], true);
    check(
      canary.child.status === 0 &&
        canary.child.stderr === '' &&
        canary.child.stdout ===
          'CANARY_CHILD_EXPECTED_INJECTION_OK\nCANARY_PARENT_EXPECTED_INJECTION_OK processes=2 attempts=16\n' &&
        canary.attempts.length === 16 &&
        new Set(canary.attempts.map((call) => call.pid)).size === 2 &&
        (canary.trace.match(/\(INJECTED\)/g) ?? []).length === 16 &&
        canary.trace
          .split('\n')
          .filter((line) => line.includes('(INJECTED)'))
          .every((line) => line.includes('EPERM')),
      'Canary did not validate the unchanged all-network-denied belt',
    );
    write('canary.json', { state: 'GREEN safety-belt-only', injected: 16, processes: 2 });
    verify();
    for (const name of [...BOUND_CASES.map((entry) => entry.name), ...NORMAL_CASES]) {
      activeCase = name;
      const observed = launch(artifact.path, name, ['--case', name]);
      lastObservation = {
        status: observed.child.status,
        networkAttempts: observed.attempts.length,
        stderrEmpty: observed.child.stderr === '',
        descriptorGuardObserved: observed.trace.includes('close_range('),
      };
      check(
        observed.attempts.length === 0 && !observed.trace.includes('(INJECTED)'),
        'Native zero-network-attempt assertion FAILED',
      );
      check(
        observed.child.status === 0 &&
          observed.child.stderr === '' &&
          observed.trace.includes('close_range('),
        'Native case did not complete/retain descriptor isolation',
      );
      const data = decodeEvidence(observed.child.stdout);
      if (BOUND_CASES.some((entry) => entry.name === name)) {
        const bound = data?.bound_request;
        if (
          typeof bound?.owner_current_before_create === 'boolean' &&
          Number.isInteger(bound.transport_executions)
        ) {
          lastObservation.ownerCurrentBeforeCreate = bound.owner_current_before_create;
          lastObservation.transportExecutions = bound.transport_executions;
        }
        validateBoundEvidence(data, name); // SAME expected0 contract for RED and GREEN. Never stage-relaxed.
      } else validateEvidence(data, name);
      write(`${name}.json`, data);
      records.push({ case: name, state: 'PASS', networkAttempts: 0 });
      console.log(`${name}: PASS; native network attempts=0`);
    }
    complete = true;
  } finally {
    let provenanceStableAfter = true;
    try {
      verify();
    } catch {
      provenanceStableAfter = false;
    }
    write('summary.json', {
      state:
        complete && provenanceStableAfter
          ? 'COMPLETE bounded native observations'
          : 'STOPPED/INCOMPLETE',
      profile: manifest.profile,
      candidateStage: manifest.candidate_stage,
      activeCase,
      lastObservation,
      provenanceStableAfter,
      provenanceSha256: options['provenance-sha256'],
      canarySha256: options['canary-sha256'],
      boundPassed: records.filter((record) =>
        BOUND_CASES.some((entry) => entry.name === record.case),
      ).length,
      authRegressionPassed: records.filter((record) => NORMAL_CASES.includes(record.case)).length,
      records,
      limitations: [
        'Synthetic FILE snapshots and actual public frozen-B client with in-memory transport only',
        'No filesystem namespace/general malicious-binary sandbox',
        'Boundary owner check is not idle/atomic revocation',
        'No HTTP delivery/WS/helper/daemon/401/freshness/provider entitlement/microphone/audio acceptance',
      ],
    });
    check(provenanceStableAfter, 'Frozen bound-call provenance changed during batch');
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(
      `Bound-call evidence STOP: ${error instanceof Error ? error.message : 'invalid evidence'}`,
    );
    process.exitCode = 1;
  }
}
