# Subscription WebRTC voice: implemented control plane, activation blocked

The daemon exposes the v1 contract in [`src/voice/types.ts`](../src/voice/types.ts).
The broker, protected HTTP routes, ephemeral lease SSE and JSON-RPC transport can
be exercised with injected local protocol fixtures. **The installed Codex adapter
is unavailable before process creation or account/auth RPC.** There is no runtime
configuration, browser parameter or API-key fallback that enables it.

This is not completion of issue #15. Fixture negotiation is not a live
subscription connection, recognized microphone speech, audible output,
interruption, or proof of provider execution isolation. No physical microphone or
live provider is needed for the deterministic/local integration tests.

## Current version-pinned blocker

Primary source reviewed: OpenAI Codex release `rust-v0.164.0`, commit
[`6aaac694803004a63c6f393d153c96d22521a6b9`](https://github.com/openai/codex/tree/6aaac694803004a63c6f393d153c96d22521a6b9).
This identifies reviewed release source, not a reproducible binary attestation.

- [`realtime_conversation.rs:1790–1825`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/realtime_conversation.rs#L1790-L1825)
  routes a `HandoffRequested` into backing-thread input **before** emitting its
  event. The branch does not check `client_managed_handoffs`.
- [`turn_input.rs:748–773`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/turn_input.rs#L748-L773)
  admits that input through normal `StartOrSteer` turn handling. Conversely,
  [`handoff_out`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/realtime_conversation.rs#L940-L958)
  uses client-managed handoffs to suppress **output forwarding**, not execution.
- An internal [`ToolPolicy`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/ext/extension-api/src/tool_policy.rs)
  can capture an empty tool allowlist before thread startup. The reviewed
  [`thread/start` processor](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server/src/request_processors/thread_processor.rs#L1522-L1569)
  does not expose or inject that policy. Changing stdio to another App Server
  transport does not add such a parameter to this request processor.
- Tools have independent shell, MCP, utility and delegation construction paths.
  [`Session-start hooks and skills/plugins`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/turn.rs#L327-L342)
  are also outside the ordinary tool registry. Empty client dynamic tools or a
  shell-only toggle is not comprehensive execution prevention.
- [`Exec policy`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/exec_policy.rs#L803-L845)
  permits ordinary sandboxed commands without approval. Read-only sandboxing,
  `approvalPolicy:never`, denied approval requests and prompt prohibitions do not
  establish no execution, including auto-approved reads.

The current adapter therefore cannot meet NUAAI's no-independent-executor
requirement. An execution notification tripwire is containment/evidence only; it
cannot prevent an action already admitted before the notification. This is a
verified blocker for this integration, **not** a claim that no future/supported
upstream mechanism could exist. Reconsideration requires an enforceable
pre-admission mechanism and independent evidence covering built-ins, reads,
MCP/apps, hooks/plugins, delegation and inherited configuration. Do not patch the
installed CLI or manufacture a no-tools flag.

## Managed subscription and interruption limits

WebRTC uses the configured model client and matching auth for call creation and
its control sideband. The separate WebSocket-start transport has different
API-key requirements and is not a fallback. Reviewed
[`provider auth resolution`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/model-provider/src/auth.rs#L246-L270)
can prefer configured provider credentials over managed account state. Removing
API-key environment variables and selecting a provider named `openai` does not
alone constrain inherited endpoints, command auth or bearer overrides. Future
activation needs supported effective-provider/auth enforcement without exposing
or copying credentials.

**Do not set `forced_login_method` as a harmless preflight check:** reviewed
[`login restriction enforcement`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/login/src/auth/manager.rs#L1368-L1427)
can log out the managed store on a mismatch. NUAAI's unavailable voice adapter
does not invoke this or change account state. Plan metadata is not voice quota
or entitlement evidence.

V3 [`delegation.created`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs#L75-L95)
has a concrete item ID, exposed as `handoff_id` in App Server
`thread/realtime/itemAdded` (`handoff_request`). It enables deduplication within a
lease, but does not solve backing execution or establish restart-safe delivery.
The reviewed App Server realtime RPC family has no explicit speech-interrupt
method. V2 truncation behavior must not be assumed for V3. The installed adapter
reports interruption unsupported rather than inventing acceptance.

## Control-plane invariants

- Only authenticated daemon clients access voice routes; pairing and expired
  credentials retain the existing `AUTH_REQUIRED` / `AUTH_EXPIRED` error shape.
  Voice-specific failures use `{error: VoiceFailure}` separately.
- Fixed WebRTC/v3/audio/subscription-only profile; no raw RPC proxy or client
  provider/environment/permission selection. SDP is only in bounded direct
  negotiation responses, never durable events, logs or replay.
- A lease is bound to its creating credential digest, real session/thread,
  retained identity/workspace and current daemon web authority. This is the
  existing single-operator model, not multi-user tenant isolation.
- Generation/revision/sequence fence stale observations. Eager deadline and
  authority checks guard incoming events, admission, controls and delayed result
  delivery; cleanup timers are backstops, not permission checks.
- One canonical handoff ID maps to at most one runtime admission in a lease.
  Runtime tools and approvals remain authoritative. Replay/browser transcripts
  do not authorize another executor or approve actions.
- **Hang-up, expiry and navigation preserve admitted durable runs.** They stop
  media/lease/delivery only; explicit run cancellation is separate. Later results
  remain in their owning conversation, never a replacement voice lease.
- Provider acceptance of a result is not playback. Browser peer/playback/mute
  states are observations, not evidence that a task succeeded or sound was heard.
- Cleanup and queues have finite bounds; loss of authenticated renewal expires a
  lease, and shutdown stops all leases before runtime/database teardown. No
  automatic provider restart, result resend after uncertain acceptance or mic
  reacquisition.

## Exact origin and trusted local proxy assumption

Voice mutations require the exact effective origin (scheme, host and port),
JSON content type and authenticated cookie or bearer credential. Null, malformed
or multiple origins, cross-site fetches and query credentials are rejected.
A bearer client may omit Origin; it cannot bypass a supplied wrong Origin.

The Node gateway retains its actual validated **Host** and only upgrades its
effective scheme to HTTPS when the socket peer is exactly `127.0.0.1`, `::1` or
`::ffff:127.0.0.1` and a **single** raw `X-Forwarded-Proto` value is exactly
`https`. Lists/duplicates/malformed values cannot upgrade the scheme. Forwarded
host fields are never used. `/nuaai` mount stripping does not change the origin.

This is an explicit trusted-loopback deployment assumption, **not proof that a
request came from Tailscale**. The local reverse proxy must overwrite the
forwarding header. Trusted local processes can supply it; this policy is not
suitable for untrusted local proxies or multi-user isolation. Authentication,
cookie issuance, runtime permissions and WebSocket origin policy are not relaxed.
Non-loopback spoof rejection is covered by a pure resolver test; real socket
integration tests exercise the loopback HTTP/proxy and mounted route boundaries.
