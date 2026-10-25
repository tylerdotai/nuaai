# Linux-only executor-free voice library compile probe

The default executable remains an **explicitly invoked feasibility probe**.
The separate default-OFF `subscription-voice` feature now supplies the actual
trusted-local subscription helper described below; it is never built by npm. It is not imported by the daemon, included in the
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

## Actual subscription helper (explicit opt-in)

`subscription-voice` builds `nuaai-subscription-voice`, with **no arguments**.
This is working adapter source, not a synthetic provider or an executor: native
managed login -> actual pinned SDK call creation -> actual same-call SDK sideband
-> exact handoff/result correlation. Lead owns source/build review, the first
bounded real signaling check, trusted-local daemon integration and user preview.
Worker source/unit/build verification does not execute real managed auth or a
provider call. It does not activate a microphone.

```sh
cargo +1.99.1 build --offline --locked --manifest-path native/voice-probe/Cargo.toml \
  --features subscription-voice --bin nuaai-subscription-voice --jobs 2
cargo +1.99.1 test --offline --locked --manifest-path native/voice-probe/Cargo.toml \
  --features subscription-voice --lib --bin nuaai-subscription-voice --jobs 2
```

Native behavior:

- Same strict u32BE v1 flat JSON/limits/command IDs as the frozen offline codec;
  hello advertises only `subscription-webrtc-v3`/`unsupported`. Offline profile
  and its three-code contract stay unchanged. Live errors use the fixed live
  allowlist; no upstream error bodies, SDP or credentials are logged. Actual
  call/sideband SDK errors additionally emit one short stderr metadata line:
  `NUAAI_VOICE_DIAGNOSTIC operation=call|sideband kind=api|http|timeout|build|transport|stream|invalid_request|other status=0|100..599`.
  Fields come only from native enum variants/status integers, never error
  Display/Debug, URLs, messages, bodies, headers, account or call IDs. Host
  logging must parse only this bounded whitelist and discard all other stderr.
- Hello is inert. Only start reads existing native managed credentials using
  `AuthManager::new`/`auth_cached` and the pinned native default File storage.
  Lead verified the host's CLI storage setting is absent/default; nondefault CLI
  config resolution is NOT claimed. The initial manager and all fresh reads use
  the same `AuthCredentialsStoreMode::default()`; no Auto/keyring-error fallback.
  HOME/CODEX_HOME are trusted host paths, never JSON fields. No manual
  credential-file parsing, forced login, refresh, logout or account writes.
  A managed **Unavailable** auth factory exists before the constructor and is
  never enabled. API-key/PAT/Agent/external-token auth is rejected.
- Actual cached managed ChatGPT B becomes the static native auth provider; exact
  single Bearer/account header binding and user identity remain mandatory.
  Nonempty login-owner marker requires the strict public persisted-owner API;
  false/error NEVER downgrades, and an empty marker is invalid. Legacy absent
  marker uses public native `load_auth_dot_json` in the same strict File store,
  with errors/missing/malformed/non-ChatGPT records rejected. Fresh account and
  optional user identity must match exactly (present user cannot disappear or
  change), and a newly appearing marker rejects the old legacy session. No own
  auth/config parsing, credential mutation or refresh. This legacy guard is a
  manual persisted identity check, NOT an atomic login-generation guarantee.
  Plan metadata is NOT a local entitlement gate: the service decides
  subscription/access/quota via its responses. Frozen auth/manual checks are
  not atomic leases or token freshness guarantees.
- Production V3 defaults are audited against pinned Core, not SDK test fixtures:
  `gpt-live-1-codex`, native voice `cove` (V3 default_v1), FramelessBidi,
  conversational audio. Both call/control carry `openai-alpha: quicksilver=v2`
  and public native `default_headers()` (real process originator/User-Agent,
  optional residency), with no auth/account replacement. No new dependencies,
  fake originator value or TLS/proxy/root-policy relaxation. Constructor-only
  unit coverage proves the managed pool builds without auth/store/send/DNS;
  route/TLS creation is lazy, so this is NOT a TLS/connectivity proof.
- Fixed ChatGPT backend JSON call POST, native V3 query/session configuration,
  bounded response131072 and deadline25s. Real answer is emitted/flushed before
  joining the official public SDK existing-call control sideband at its default
  `wss://api.openai.com/v1/live/{encoded-call-id}`; same frozen native auth. No
  API-key fallback or inherited endpoint/proxy/TLS/auth override is accepted.
- SDK Speakable append binds the actual handoff ID; delivery ID remains local
  for exact echo. Accepted means SDK write, NOT audible playback. Partial/error
  sends report unknown without retries. Identical handoff replay is ignored;
  conflicting replay is fatal. IDs are retained in bounded256-entry maps;
  at most16 queued/active result writes.
- Actual typed user/assistant transcripts have per-role utterance IDs, UTF-8
  byte-bound16k accumulated partials and authoritative final text. Empty deltas
  and silent Done events cannot emit invalid empty-text frames. AudioOut and
  unrelated SDK metadata are discarded before native owner checks; WebRTC owns
  media. No audio/base64 crosses stdio.
- Non-socket numeric stdio only; successful close_range(3+) before runtime.
  Only trusted HOME/CODEX_HOME/PATH/LANG/TZ survive. FIFO I/O is nonblocking;
  partial prefix/SDK-event futures persist across select, and interrupted
  stdout frames finish before closed/error framing. Close/EOF cancels join or
  pending writes, attempts SDK close once and bounds cleanup. Native read-only
  keyring work is isolated from the reactor, with2s waits and a50ms runtime
  shutdown cap so a stalled desktop bus cannot pin helper shutdown indefinitely.

Known native-library boundary: the pinned SDK owns an internal unbounded receive
channel. This adapter drains ignored audio cooperatively and bounds its own
stdio, transcripts, handoff memory and result queue; it does not claim the SDK
channel itself is bounded. No supported provider interruption API is asserted.

### Private read-only auth metadata diagnosis

The same default-OFF feature also builds `nuaai-voice-auth-metadata`, a separate
private no-argument diagnostic, not a helper profile or signaling client. It
reuses the exact entry guard and permanently Unavailable auth factory. It emits
only fixed booleans for managed identity/account/user/login-owner/header/strict
owner-check presence plus stages and numeric timings. No native identity/token
values, paths, raw errors, content factory, refresh or credential writes.
Execute against a real managed store ONLY after Lead source/artifact clearance.
This diagnostic does not relax production admission or claim a legacy root cause.

## What executes by default

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

## Separate actual-SDK existing-call component

Opt-in feature `synthetic-ws-runtime` adds only `synthetic-ws-runtime`
(`src/bin/synthetic_ws_runtime.rs`). Its companion Node `ws` fixture is
`fixtures/ws_happy_cycle.mjs`. This is **not** the native helper or its framing:
the fixture pre-registers `rtc_fixture_A`, requires zero HTTP attempts/creates,
and exercises the pinned public existing-call join, typed A/B handoffs,
Speakable B-then-A emoji results split at <=500 UTF-8 bytes, and one SDK close.
It uses fixed fake headers, never AuthManager or real credentials.

Build only after exclusive-cache handoff and source review. Execute only after
ELF/bundle/profile review inside the approved private Docker network/filesystem
namespace with both fixture and client inside it. Do not run this component on
the host or under a relaxed auth harness. It adds no dependencies, changes no
helper wire lock, and remains excluded from npm packaging/default capability.

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

### Functional offline private helper

`offline-helper-tests` (default OFF, independent of auth-test features) builds
`offline-voice-helper`. It implements the fixed `helper-u32be-v1-FROZEN` contract:
4-byte BE length + strict UTF-8 flat JSON (max131072 bytes), hello/start/append/close,
answer before control_ready, exact command/handoff/delivery IDs, and closed/EOF.
No NDJSON, generic RPC, URLs, auth fields, provider selection or interrupt command.
The only backend is inert memory: it returns synthetic SDP, emits two fixed
`offline-handoff-A`/`offline-handoff-B` tasks, accepts exact-ID results in either
order, chunks text at500 UTF-8 bytes, and closes once. `accepted` means local memory
acceptance, never provider delivery/audio playback. The daemon-installed provider
remains unavailable.

```sh
cargo +1.99.1 test --offline --locked --features offline-helper-tests --bin offline-voice-helper --jobs 2
cargo +1.99.1 build --offline --locked --features offline-helper-tests --bin offline-voice-helper --jobs 2
```

The executable rejects socket stdio and closes FD3+ before clearing its environment
and reading frames. It creates no runtime, auth manager, credential store or network
client. Do not host it with Node `stdio:'pipe'` socketpairs: use owned regular files
for finite fixtures or real OS pipes/FIFOs inherited as integer descriptors for
interactive Node transport tests. EOF, malformed/truncated frames, unknown/duplicate
fields, replay and mismatched IDs terminate safely with bounded static errors.

### Opt-in native B -> in-memory call composition

Feature `synthetic-bound-call-tests` (default OFF, implies `synthetic-auth-tests`)
adds only `bound_create_uses_B`, `bound_owner_drift_before_create` and
`bound_frozen_B_after_rotation`. It reuses the same internally generated FILE
fixtures, actual native A/B constructors, permanently Unavailable auth factory,
native FD guard and time-only runtime. The existing 23-case JSON v1 is unchanged;
only these three cases use JSON v2 with fixed `bound_request` checks.

The actual native frozen B provider, not a replacement AuthProvider, is passed
to public `RealtimeCallClient<RecordingTransport>`. Its real execute method counts
entry attempts and invokes actual `Request::prepare_body_for_send()`, checking
exactly one B bearer/account pair, not A or the internally rotated C. The reserved
`.invalid` URL is request data only; this transport never resolves or connects.
An inert recorder is allocated before the public persisted-owner recheck so a
zero call count is measured. Owner drift must deny client construction/dispatch;
same-owner token rotation after freeze must not silently change B's header pair.

The RED candidate is separately fingerprinted before the missing owner admission
check is repaired; its actual ownerfalse/request1 result must fail the strict
zero-request oracle under the same reviewed syscall-denial harness. No constructor
execution is permitted before complete source/compiler/feature/ELF review and
canary validation. The guarded candidate must be built/frozen independently after
an explicit RED-run release. These tests prove neither atomic/idle revocation nor
real content networking, freshness, entitlement, WebSocket, helper or activation.

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
