# Explicit offline native-auth evidence runner

This is test infrastructure, not a live voice adapter. Nothing here is wired to
npm install, daemon startup, or root npm scripts. The runner uses Node built-ins
and Node 22.23.4's built-in TypeScript stripping for `regular-stdio.ts`; it does
not invoke Cargo, install dependencies, read real credentials, or discover auth
stores. The ordinary repository integration/unit tests use existing Vitest.

## Preconditions

1. Obtain an explicitly reviewed **frozen** candidate: complete source, Cargo,
   lock, compiler, feature/build argv, and normal/fault ELF provenance. Record the
   reviewer-approved provenance SHA256 independently. A matching hash does not
   replace source review. The producer must make no source/build/cache writes
   until the evidence run finishes and the consumer explicitly releases it.
2. Use only Linux/x86_64 and the approved synthetic File fixtures. Native case
   names are fixed in the runner; caller-provided homes, auth values, endpoints,
   arbitrary native arguments, and actual provider services are not supported.
3. Compile the harmless std-only canary explicitly, if an approved exact canary
   artifact is not already available. This is **not** another Codex build:

   ```sh
   rustup run 1.99.1 rustc --edition=2024 \
     tests/native/network-denied-canary.rs -o <private-canary-path>
   sha256sum <private-canary-path>
   ```

   Keep the output in an owned private directory. Review/record its source,
   toolchain and binary digest. The current independently verified canary digest
   is `c3b50d7853312cddd1c9c18d745184b078507b40282dd40f5999e402070bdd4b`;
   rebuilding elsewhere need not produce the same binary digest.

## Explicit invocation

From this repository's root, after source approval and producer freeze:

```sh
node tests/native/run-synthetic-auth.mjs \
  --normal-artifact <reviewed-normal-ELF> \
  --fault-artifact <reviewed-opt-in-fault-ELF> \
  --provenance <complete-frozen-provenance.json> \
  --provenance-sha256 <independently-approved-provenance-digest> \
  --canary <approved-canary-ELF> \
  --canary-sha256 <independently-approved-canary-digest> \
  --output-dir <new-private-evidence-directory>
```

There are no defaults, arbitrary case/URL/store flags, automatic builds, or
implicit live entry points. The output directory must not already exist. The
manifest schema is checked before any child runs, including all eleven source
entries, the compiler, exact pinned build/features, both ELFs and the manifest
itself. Fingerprints are checked again after the run, including on failure.
Provenance JSON is retained as metadata; source/store contents are not copied.

The canary must first show sixteen EPERM(INJECTED) calls across parent and child.
Only then can ordinary native cases run. Every actual native network/io_uring
attempt is a failed zero-attempt assertion, even if safely blocked. **AF_UNIX is
not exempt.** The 23 ordinary cases are scored separately from two intentional
fault counterfactuals. Each fault must finish with valid fixed-schema JSON and a
real AF_INET/AF_INET6 stream TCP socket attempt, with protocol 0/TCP, intercepted
by the belt. A socketpair, unrelated setup, parse-only error, no-I/O panic, or
zero attempts does not prove the counterfactual. Expected RED native assertions
are never added to the ordinary green count or called policy enforcement.

All children get /dev/null stdin and exclusively created 0600 regular stdout and
stderr files, not Node `pipe` endpoints (which can be Unix sockets). The env is
cleared and each child gets a disposable fabricated home. strace follows all
children, kills tracees on tracer exit, denies network/io_uring, and logs raw
arguments without read/write buffers. The native entry independently checks
non-socket stdio and closes descriptors >=3 before temporary homes/runtime/auth.
The capture read limit is not a disk quota. This is not filesystem isolation or
a general sandbox for malicious binaries.

## Regression evidence and acceptance limits

- `regular-stdio.integration.test.ts`: five actual subprocess regressions,
  including a Node-pipe negative control. Controlled old-launcher RED and fixed
  regular-file GREEN canary evidence are retained separately.
- `synthetic-auth-runner.test.ts`: pure schema/secret-free diagnostic/trace/TCP
  oracle regressions; they never invoke auth, Cargo, stores or native artifacts.
- A source-drift abort before spawn is provenance failure, not native-policy
  failure. A Tokio signal-initialization socketpair blocked before constructors
  is a real native zero-attempt failure, not a managed auth-policy result. Never
  rerun those old artifacts to turn the record green.

Persisted-owner drift here is a manual metadata recheck, not an idle connected
lease guard, continuous/atomic revocation, or transport close. PAT's fixed
request-site denial message is lossy and paired with a separate TCP fault trace;
it is not a typed error cause. No content/401/freshness/WS/helper/daemon/provider
entitlement/microphone/audio acceptance follows from these probes. Full mutation
remains deliberately stopped; these are explicit bounded counterfactual tests.
