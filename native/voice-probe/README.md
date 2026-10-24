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

The executable resolves exported function items and prints a static provenance
line. It does **not** call any referenced auth constructor, native store/keyring
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

## Next milestone is separately reviewed

Future synthetic auth tests must explicitly select isolated temporary FILE
storage, no actual HOME/Codex home discovery and no OS keyring, with managed
Unavailable network policy installed **before** any native auth construction.
The first proposed proof is A native-storage preflight, B cached manager snapshot
and persisted-owner checks, then a validated frozen Authorization/account header
pair. Its auth factory stays denied; a truly separate content policy permits only
controlled loopback fixtures. Missing/malformed headers and 401 fail closed, with
no refresh or credential-mode substitution. Neither mode-only checks nor native
`get_token` calls establish token freshness. No such fixture flow is implemented
by this compile-only crate yet.

No real auth-store read, provider/auth RPC, account operation, physical microphone,
paid API, or live acceptance is authorized by the build probe. Production remains
unavailable. No typed V3 speech interruption contract was established.
