# Independent Linux executor-free helper test proposal

Status: proposal for the approved native build, **not executed evidence**. Eval owns this worktree/plan and eventual adversarial tests; backend owns native manifest/lock/toolchain/typecheck first. Base PR16: `9e6a93eb1128997a505b2869f59541df0b7bdd23`; upstream source pin `6aaac694803004a63c6f393d153c96d22521a6b9` (0.164.0). Reuse the backend's exact built artifact; no duplicate heavy builds, guessed helper CLI, actual managed credentials, auth/provider calls, refresh, microphone or mutation restart.

## Required artifact handoff before execution

Backend supplies binary path + SHA256, source commit/dirty-diff fingerprint, toolchain and lock identity, exact CLI/JSON schema and the reviewed fixture-only entrypoint. It must require explicit fabricated auth home and File storage, never fall back to the user's home/keyring/config, and never direct a test request to a first-party service. Check linked dependency scope for no Codex core/App Server/exec host. Presence of process/PTY/sandbox utility libraries is not itself a backing executor.

Tests will use temporary roots and generated **synthetic** tokens/IDs. Start a child with an environment allowlist and fabricated HOME/CODEX_HOME; do not inspect inherited credential values. Trace only this child's syscalls. Actual bwrap network smoke failed RTM_NEWADDR EPERM; actual unshare user/net smoke failed uid_map EPERM. No filesystem namespace is established. Lead instead explicitly approved owned-child strace syscall injection for the initial network-denied phase: follow all descendants, kill tracees on tracer exit, raw argument logging, deny all network and io_uring entrypoints. Own std-only `tests/native/network-denied-canary.rs` validated sixteen expected EPERM injections across two processes, with stdio non-socket checks and close_range for extra inherited descriptors. These intentional canary attempts validate the safety belt only. **Actual auth tests require ZERO network/io_uring attempts; any injected call or EPERM is failure**, not proof. Any claimed bootstrap-policy proof additionally requires an actual denial witness (Destination for a disallowed endpoint or Unavailable for an allowed endpoint while the controller is unavailable), or a source-correct fenced fault counterfactual. The public policy checks the endpoint restriction first; a direct oauth/token Unavailable probe does not prove a constructor's whoami/JWKS request reached the controller branch. Parse/environment-only rejection must remain a separate category. Positive content fixtures run separately. Never point a constructor test at a real store; explicit fabricated File-mode paths remain required despite the network belt.

## Auth construction: two snapshots under permanent denial

The initial proof uses **public** `CodexAuth::from_auth_storage` for A, then public `AuthManager::new`/`auth_cached` for B, both with a managed Unavailable auth policy. Only exact managed Chatgpt A/B are eligible. Public `account_login_is_current(A/B)` checks current persisted owner. Mint immutable `auth_provider_from_auth(B)` only after eligibility; never use the manager-backed provider for this first milestone. No `auth()`, refresh, reload, login enforcement, testing constructors or raw stored-payload getters.

Auth factory/controller stays DENIED for its entire lifetime. Content fixture has a separate controller, not merely another factory sharing the same policy Arc. A valid-looking token that receives401 fails closed; no refresh/fallback. The source's `BearerAuthProvider` silently omits invalid/missing bearer or account header and returns Ok: the helper must validate **both** resulting headers and their binding before any content attempt.

### Matrix A: default-DENY and mode eligibility

1. No stored auth: unavailable, zero content attempts, zero auth connection attempts.
2. Synthetic persisted API key: rejected, zero content/auth connections.
3. Synthetic persisted PAT: deny its metadata bootstrap before DNS/connect; rejected, no fallback.
4. Synthetic persisted AgentIdentity JWT and record needing registration: deny JWKS/registration before DNS/connect; reject or safely fail parse, never contact a provider.
5. Synthetic external/header/unsupported modes: reject, do not coerce them to managed Chatgpt.
6. Constructor-level adversarial env PAT/agent identity: intentionally bypass the wrapper env stripping in this test to exercise permanent denial. Zero auth connections; no live endpoint.
7. Wrapper-level env API key/access-token/base-URL/JWKS/refresh overrides: removed by allowlist. When paired with valid fabricated managed storage, only that managed identity may be used; do not incorrectly assert that an irrelevant stripped API-key env must poison a valid managed login.
8. Malformed/absent owner/account/user/plan/token fields, unknown plan, invalid bearer/account header (including CR/LF): fail before any content attempt. No default-account or unauthenticated probe.
9. Malformed store/storage error: safe bounded failure, no secret/SDP echo, no retry against another auth source.

**Zero-DNS evidence must be precise.** A numeric-loopback endpoint needs no DNS even with a broken gate, so zero loopback accepts alone does not prove ordering. Prefer a real pinned RouteAwareClientPool test with an injected resolver callback counter (if public), plus constructor policy-denial/no fixture accept witnesses and syscall traces. Source already acquires before route/proxy/DNS, but label source, callback and whole-process observations separately. Do not claim a stub counter observes constructors it is not wired into.

### Matrix B: snapshot and ownership races

10. A/B exact same managed owner/account/user: pass local eligibility; auth factory remains denied; frozen B header pair is used by every recorded content request.
11. A -> B account switch, user switch, login-owner change, or managed -> PAT/API/agent mode: reject while auth remains denied. No content call.
12. Same owner with token rotation between A/B: either explicitly accept B's latest token or conservatively reject, according to documented policy; never mix A bearer with B account header.
13. Replace persisted owner between B load and current-owner checks: reject, zero content attempts.
14. Replace owner after the precheck while mock call creation is held: discard late result, do not expose SDP or join sideband; close/revoke the lease. One already attempted mock call is possible: do not falsely claim zero past calls or atomic cross-process logout prevention.
15. Drift during sideband join/result append: discard late completion, close/fence generation, no later append or delivery into a replacement lease.
16. Token401: zero auth-network attempts and no automatic header switch/refresh. Subsequent content requests, if any are allowed by policy, must still use exactly B's frozen validated headers; preferably no automatic create retry in the first proof. Public get_token_data/get_token do NOT enforce JWT exp. Include synthetically expired metadata: assert known-expired preflight rejection only if the helper actually implements it; otherwise assert the recorded401 fails closed. Never claim that the library checked expiry, verified an access-token JWT, refreshed credentials, or established entitlement. Header telemetry/account-binding assertions must not print token/header values.
17. After successful local eligibility, inject unsupported mode into the fabricated store and exercise all allowed metadata checks: auth controller remains denied forever; no latent bootstrap can escape through a newly enabled policy.

Additional idle-drift case: `auth_change_state_receiver` subscribes to this manager's state updates; it does not independently watch another process changing the persisted store when auth/reload are never called. Hold an otherwise idle connected synthetic lease, replace its fabricated persisted owner, and require a documented bounded storage-only renewal/control check to detect drift, revoke and close. A browser heartbeat by itself is not provider-store validation. Inject a clock/latch where possible, not a sleep or an actual store. Operation-boundary checks alone must not be advertised as continuous/atomic revocation.

## Real public call/protocol tests, no invented transport

18. Use the actual pinned generic RealtimeCallClient with recording HttpTransport. Assert method/path/query/content-type, JSON{sdp,session}, no forwarded session id, valid SDP/call-id response, identical validated B auth. Never run the recording transport against a provider.
19. Exercise missing/invalid Location, non-UTF8 answer, oversized SDP/events, untrusted call ID and cancellation/error paths using the real public client or clearly label any standalone parser mirror as narrower evidence.
20. Public sideband client on a separate local fixture only, if an actual mock WebSocket seam is delivered: verify same call binding, same B auth, existing-call join does not create an executor/turn or overwrite session. Otherwise compile/source evidence only, no runtime sideband claim.
21. Feed client delegation with stable item/handoff ID, duplicated/reordered events and unsupported execution-shaped events. Normalize only allowed events. No hidden turn/task/subprocess, no generic raw-frame IPC. Existing daemon admission/idempotency remains authoritative.
22. Results are appended only to the matching live lease/generation; append success is delivery attempt, not provider speech or audible playback. No typed V3 interrupt is claimed; reject unsupported interrupt rather than send an invented raw frame.
23. Cancellation/EOF/timeout/failure cleanup: policy revoke, sideband/fixture transport close and bounded child exit; late responses cannot revive a lease. No timeout increases, sleeps-as-proof, retries-to-green or swallowed failures.

## Independent host observations

- Exact artifact fingerprint before/after, working-tree/source/lock fingerprints and commands.
- Own child exec/connect/send syscalls if tracing/isolation is usable; no inherited real auth paths, no backing Codex/App Server/exec child. A PATH tripwire alone is detection, not prevention.
- Auth phase and content-fixture phase run separately so expected local fixture traffic cannot hide auth-phase leakage. Avoid any external host even on intentionally failing cases.
- No synthetic token, SDP canary, raw headers or unsupported event payload in helper diagnostic logs. Keep intentional fake values local to tests and record only sanitized assertion evidence.
- Preserve failing-before results, expected controlled negatives and cleanup evidence. Missing artifacts/build failures are blockers, not skips or passing test counts.

## Reproduce the harmless fence canary

Compile only the std-only canary with the already approved toolchain; this is not a second Codex dependency build:

```sh
rustup run 1.99.1 rustc --edition=2024 tests/native/network-denied-canary.rs -o <private-canary-path>
```

Use a newly created private temporary directory for each HOME/CODEX_HOME and run the executable with:

```text
env -i PATH=/usr/bin:/bin HOME=<fabricated-home> CODEX_HOME=<fabricated-home> CANARY_SYNTHETIC_HOME=<fabricated-home> timeout --signal=TERM --kill-after=2s 20s /usr/bin/strace --kill-on-exit -f -qq -e trace=%network,io_uring_setup,io_uring_enter,io_uring_register,execve,execveat,close_range -e raw=all --inject=%network,io_uring_setup,io_uring_enter,io_uring_register:error=EPERM -o <private-trace-path> <private-canary-path>
```

Require both parent/child markers, sixteen EPERM(INJECTED) calls across two tracee PIDs, exit0 and no extra attempts. The canary uses only unconnected socket creation or invalid descriptors/null arguments, never a remote endpoint; it closes any unexpectedly successful socket before failing. Its deliberate injected calls are **not** allowed in actual auth cases. Actual helper runs use shell-free argv, only standard non-socket stdio descriptors, a cleared fabricated environment and an independently verified exact artifact. Node `stdio: 'pipe'` is not sufficient: on this Linux/libuv build it produces Unix socket endpoints. A canary revalidation rejected that launcher with exit101 before any network exercise. `tests/native/regular-stdio.ts` instead opens owned0600 regular stdout/stderr files exclusively and passes their descriptors, with /dev/null stdin; five real subprocess integration regressions cover regular descriptors, the pipe negative control, nonzero exit preservation, no overwrite and bounded capture reads. Controlled canary RED101/zero injections and corrected regular-file GREEN16/16 injections across two processes are separately retained. The capture-read bound is not a disk quota or general sandbox. The strace belt is not a filesystem sandbox or a guarantee for arbitrary hostile binaries/other architectures.

Independent exact static observation already completed at backend source2b72ed4d5c6f94b0e8bb1e1cc7c54468e4e38278: binarySHA ca71bd3bbbdeec8ae201021903201f5d0841fa110e0cd6c61278c37388101c01, lockSHA5ef634f18e9fcd2928949bbb58a2d8cce32df45768952378c35f847eb0953b61; zero network/io_uring attempts, exact static compile-only stdout, empty stderr, exit0, unchanged binary/source/lock fingerprints. This was function-item references only; no auth constructor or protocol fixture was exercised.

## Acceptance boundary

Typechecking validates public symbols, not entitlement, audio, auth isolation or interruption. Offline synthetic tests validate only their actual seams. Real credential access, managed refresh/auth RPC, provider WebRTC and physical mic/listening remain separately unapproved. Build/probe work must not activate the installed adapter or close issue15 by itself.
