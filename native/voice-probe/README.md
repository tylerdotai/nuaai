# Linux-only executor-free voice library compile probe

This standalone crate is an **explicitly invoked feasibility probe**, not the
NUAAI production voice helper. It is not imported by the daemon, included in the
npm package `files`, or fetched/built by npm install/prepare/build.

Upstream: OpenAI Codex `rust-v0.164.0`, exact commit
`6aaac694803004a63c6f393d153c96d22521a6b9`. Dependencies use that immutable Git
revision, with the reviewed upstream workspace patches repeated in this consumer
workspace. `Cargo.lock` fixes the resolved graph. It was seeded from that exact
upstream release lock and reconciled by Cargo for this external Git consumer.
Fresh latest-version resolution was tested first and failed because Rama alpha.4
resolved incompatible stable 0.3 transitive packages; preserve this lock rather
than regenerating it from scratch. Rust toolchain is **1.99.1**; there is no
fallback toolchain or source pin.

## What executes

The default `nuaai-voice-probe` executable resolves exported function items and
prints a static provenance line. It does **not** call any referenced auth constructor, native store/keyring
lookup, provider operation, refresh, or transport constructor. There is no live
mode, private helper framing, microphone/device operation, or raw RPC passthrough.
Arguments cannot activate those absent code paths. Help/version/default execution
all have the same static, credential-free behavior.

The symbols cover public call creation, same-call control sideband, V3 delegation
append/session-context append/close, native storage snapshot/owner-check APIs,
and default-denied network policy construction. Successful compilation proves
external Rust API visibility/type availability only—not service support,
execution-isolation acceptance, entitlement, audibility, interruption or safety of
an unimplemented future auth flow.

## Explicit commands (from repository root)

```sh
cargo +1.99.1 check --locked --manifest-path native/voice-probe/Cargo.toml --jobs 2
cargo +1.99.1 test --locked --manifest-path native/voice-probe/Cargo.toml --jobs 2
cargo +1.99.1 run --locked --manifest-path native/voice-probe/Cargo.toml --jobs 2
cargo +1.99.1 tree --locked --manifest-path native/voice-probe/Cargo.toml \
  --target x86_64-unknown-linux-gnu --edges normal,build
node --test native/voice-probe/check-graph.test.mjs
node native/voice-probe/check-graph.mjs
```

The actual Linux normal/build graph must exclude `codex-core`, `codex-app-server`,
`codex-exec`, and `codex-mcp-server`. Process/PTY/filesystem/sandbox utilities can
remain transitive dependencies; their presence is not a claim they are invoked.
Unused upstream patch warnings must be recorded rather than silently changing
pins to remove warnings. Cache/target/output and private test fixtures must never
be committed.

## Opt-in synthetic native-auth proof

Feature `synthetic-auth-tests` adds the separate `synthetic-auth-probe` binary.
It accepts only `--case <fixed name>` and an extra harness marker; neither a home,
endpoint, token nor raw auth payload can be supplied. It creates its own fresh
TempDir/FILE home and fabricated fixture, clears the environment before creating
a current-thread runtime, and never uses actual homes, Auto/Keyring storage,
`auth()`, reload, refresh, login enforcement or a manager-backed auth provider.
Unknown cases fail before creating a home or constructing auth. Default execution
and help are static and do not initialize auth. A marker is **not** containment:
constructor cases may run only under the independently reviewed syscall-denial
harness, with cleared environment, regular-file stdout/stderr, `/dev/null` stdin
and no inherited network descriptors. The Linux/x86_64 native constructor entry
also verifies that descriptors 0/1/2 are non-sockets and successfully closes all
descriptors >=3 before creating a temporary home, runtime or native auth. Do not set a marker and run constructor cases outside it.

Ordinary cases exercise actual public `CodexAuth::from_auth_storage` A and
`AuthManager::new`/`auth_cached` B under a managed **Unavailable** auth factory
installed before either constructor and never enabled. Negative fixtures exercise
both constructors as a measurement, not as a production admission sequence.
The test runtime enables time only, not I/O/signals: Tokio's `enable_all` initializes
an unrelated Unix socketpair and correctly fails the strict all-network fence.
No AF_UNIX exemption is permitted. Ordinary requests must stop at native policy;
fault controls count only actual constructor transport attempts denied before
reactor registration, with clean JSON completion. An I/O-disabled panic or zero
fault attempts is a failed/unproved control, never a pass. This is not evidence of
a working I/O-enabled production helper.

Managed fixtures use public persisted-owner checks and static
`auth_provider_from_auth(B)`, validating exactly one nonempty Bearer header and
one matching account header. Only the fabricated Plus profile is locally
eligible; this proves no service entitlement. Output contains fixed categories
and boolean/null checks, never tokens, headers, account/user/owner values or raw
errors. A preserved typed policy cause and a lossy PAT request-site error message
are explicitly distinguished from an unclassified native error/parse rejection.

Store-drift cases synchronously replace their own fabricated file and manually
recheck persisted ownership. Despite the legacy `managed_idle_owner_switch` name,
this is tagged `manual_persisted_owner_recheck`: **no idle connected lease,
renewal/timer guard, continuous/atomic revocation or transport close is tested**.
The manager watch is cache-local, not an external-store watcher. Frozen headers
remaining unchanged after drift do not authorize their use after owner rejection.
No content client is constructed, token freshness remains unvalidated, and no
401 handling, request binding, WebRTC or speech acceptance is claimed here.

### Separate RED counterfactuals

Feature `synthetic-auth-faults` (default OFF, implies `synthetic-auth-tests`) adds
only `fault_unmanaged_factory_pat` and `fault_unmanaged_factory_agent`. These use
the same internally generated fixtures and literal `127.0.0.1:9` endpoints, but
deliberately omit the native factory policy. They require an additional fault
harness marker and may execute **only under eval's all-network/io_uring denial
belt**. They never publish/open a managed controller. Enabling the feature does
not alter any ordinary case's permanently Unavailable factory; a pure unit test
checks all ordinary factories in both feature configurations.

A real constructor syscall attempt must be observed in each RED counterfactual;
zero attempts leave the bootstrap witness unproved. Injected attempts are failed
native-zero-attempt assertions, recorded separately from ordinary green cases,
not successful native policy enforcement and not Stryker/mutation acceptance.

Build and pure unit tests (these commands do not execute auth constructors):

```sh
cargo +1.99.1 test --locked --manifest-path native/voice-probe/Cargo.toml \
  --features synthetic-auth-tests --jobs 2
cargo +1.99.1 test --locked --manifest-path native/voice-probe/Cargo.toml \
  --features synthetic-auth-faults --jobs 2
cargo +1.99.1 build --locked --manifest-path native/voice-probe/Cargo.toml \
  --features synthetic-auth-tests --bin synthetic-auth-probe --jobs 2
```

No real auth-store read, provider/auth RPC, account operation, physical microphone,
paid API, or live acceptance is authorized by these probes. Production remains
unavailable. No typed V3 speech interruption contract was established. Any future
content fixture requires a separately controlled policy and an independently
reviewed protocol test; it must never enable this auth factory.
