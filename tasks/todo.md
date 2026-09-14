# Codex Integration

- [x] Verify installed Codex CLI version and app-server protocol availability.
- [x] Map NUAAI runtime/provider lifecycle and choose a whole-turn app-server boundary.
- [x] Add a persistent per-session Codex app-server JSON-RPC client with initialize/thread/start/turn/start streaming.
- [x] Project Codex assistant/tool events into NUAAI persisted lifecycle events and final run output.
- [x] Add explicit Codex runtime configuration and provider selection without changing Ollama defaults.
- [x] Add Hermes-style post-tool quiet watchdog, cancellation, child cleanup, and stderr diagnostics.
- [x] Add focused protocol/runtime tests with a deterministic fake app-server.
- [x] Run focused tests, typecheck, build, and the complete local gate.
- [x] Replace the non-completing App Server model-turn route with direct Codex Responses while retaining Codex-owned OAuth refresh.
- [x] Route Codex function calls through NUAAI's existing permission-filtered tool loop.
- [x] Complete live Sol text, `workspace.list`, and `workspace.write` → `workspace.read` API runs.

## Review

The installed Codex `0.154.0` CLI and App Server could initialize, list models, and start threads but repeatedly failed to complete model turns. Hermes's own App Server client reproduced the same timeout, isolating the failure outside NUAAI's protocol projector. Direct Codex Responses completed immediately with the same ChatGPT OAuth account and model.

Production routing now uses direct streaming Responses. The endpoint is fixed, redirects are rejected, OAuth is read on demand from Codex's store, near-expiry refresh is delegated to Codex's account RPC, and structured function calls execute through NUAAI's existing runtime. The failed App Server turn adapter was removed; the existing Codex CLI compatibility adapter remains non-routed for model turns.

## v1.0 final-review remediation

- [x] Acquire an atomic daemon lock before identity, database recovery, MCP, skills, plugins, or scheduler initialization.
- [x] Route Matrix/media/audio and command reads through one protected realpath broker; block indirect file options and executable extension directories.
- [x] Preserve source ownership across Matrix `/new` and `/switch`; reject cross-owner rebinding.
- [x] Build queued-run context at execution through the queued input message, not from a stale pre-queue snapshot.
- [x] Make Matrix cursor/delivery limitations explicit and add deterministic retry identifiers where delivery is supported.
- [x] Remove unauthenticated browser credential bootstrap and require explicit browser pairing.
- [x] Make onboarding integration selection modular and root-correct for checkout, tarball, npx, and global installs.
- [x] Ship the runtime dependencies and first-party skills in the package; align all licenses with MIT and exclude host-specific dogfood tooling.
- [x] Make coverage claims match measured production surfaces and add artifact/install smoke to the canonical gate.
- [x] Re-run the complete local gate and clean-package smoke on the direct Codex Responses tree.
- [ ] Complete independent review, GitHub PR CI, tag CI, and post-release live verification.

## Conversation-first UI redesign

### Product boundary

- Keep the React/Vite client and daemon-owned truth; do not migrate frameworks or clone Open WebUI's feature surface.
- Make each assistant response the owner of structured output, activity, errors, evidence, and actions.
- Keep conversation navigation primary. Memory, Automations, capabilities, and System remain secondary durable surfaces.
- Preserve explicit fragment pairing, permission filtering, loopback authentication, safe areas, and package independence.

### Implementation

- [ ] Filter replay by session/thread before limiting; add deterministic cursors/latest-run snapshots and thread-owned cancellation.
- [ ] Add race guards for session/thread loads and normalize UI state by stable identifiers.
- [ ] Add a server-side structured message presentation contract that survives reload exactly.
- [ ] Add sanitized GFM/Markdown, code blocks, copy actions, and safe mobile overflow.
- [ ] Attach compact run status, failure, retry, inspect, and expandable activity to the owning assistant response.
- [ ] Replace forced scrolling with near-bottom autoscroll, an explicit return affordance, and anchor preservation.
- [ ] Build an auto-growing, draft-persistent, capability-aware composer with stable Send/Stop and queued follow-ups.
- [ ] Replace dashboard-heavy chat styling with a calm constrained reading canvas, desktop conversation rail, and mobile drawer.

### Verification contract

- [ ] More than 1,000 interleaved events still reload the selected thread's latest run correctly.
- [ ] Switching threads cannot show or cancel another thread's active run; stale responses cannot overwrite the current selection.
- [ ] A 48-call run renders one response-local summary and matching expandable terminal rows before and after reload.
- [ ] A real failed run shows cause plus Retry/Inspect and completes a recovery flow.
- [ ] A 20 KB Markdown/code response stays responsive, sanitized, copyable, and within 390px width.
- [ ] Streaming does not move a reader who scrolled away from the bottom.
- [ ] Desktop 1440×900 and phone 390×844 pass geometry, safe-area, console, keyboard, reduced-motion, and screenshot review.
- [ ] Lint, typecheck, full tests, per-file coverage, builds, package smoke, exact-tree review, and GitHub CI are green before release.

## Long-response streaming and finalization repair

### Proven failures

- [x] Reconstruct the live failed run from durable messages, runs, and events.
- [x] Confirm that quoted future-intent examples falsely reject a substantive final answer.
- [x] Confirm that provisional provider attempts are concatenated into one visible stream.
- [x] Confirm that thousands of token-sized events exceed the bounded reconnect snapshot.

### Implementation contract

- [x] Reset visible provisional output at every `model.started` boundary while retaining one assistant response per user turn.
- [x] Batch tiny model deltas and persist the current attempt as the authoritative reconnect snapshot.
- [x] Accept substantive non-empty final responses even when the content quotes future-intent phrases.
- [x] Allow one final no-tools grace turn after the real model-turn budget is consumed.
- [x] Keep finite timeout, output-size, and action-count safety ceilings without presenting normal completion as a budget failure.

### Verification contract

- [x] RED tests reproduce false final rejection, attempt concatenation, reconnect truncation, token-event amplification, and missing grace finalization.
- [x] Focused runtime, presentation, web-state, TUI-state, and browser tests pass.
- [x] Complete `npm run gate` passes.
- [ ] Live paired PWA streams and preserves a long multi-turn answer through reload without clipping, duplication, or a false failure.

## Permissioned tool-governance follow-up

### Keep

- [x] One central `ToolRegistry`, JSON schemas, Zod validation, capability-filtered exposure, registry-owned execution, MCP mediation, and stable per-run tool catalogs.

### Implement

- [x] Add registry-owned metadata for owner, cost class, auth mode, side effects, approval policy, and per-run tool ceiling.
- [x] Reclassify `computer.use` from read to execute because click/type actions can mutate external state.
- [x] Expose governance metadata in the capability manifest and model-facing capability text.
- [x] Enforce weighted run cost and per-tool ceilings before execution, with structured failure events and no silent fallback.
- [x] Keep post-admission execution internal so callers cannot forge a budget/permission bypass.
- [x] Produce an automated catalog audit proving every registered tool has complete governance metadata.
- [x] Keep configured MCP servers behind generic registry discovery/execution instead of duplicating remote schemas into provider catalogs.

### Reject for this repair

- [x] Do not add Composio, ACI, AgentLock, or another dependency when NUAAI already owns the executable registry boundary.
- [x] Do not mutate tool visibility with per-step top-k retrieval; keep one stable permission-filtered catalog for prompt caching and predictable access.

### Verification

- [x] RED/GREEN tests cover catalog completeness, read-only denial for computer control, weighted cost exhaustion, per-tool ceilings, and manifest disclosure.
- [x] Full canonical gate passes on the revised exact tree before deployment.

## Delayed review follow-up

- [x] Enforce `maxOutputBytes` across all generated model attempts while retaining current-attempt snapshots.
- [x] Give run-state a session-scoped event watermark and prevent stale background snapshots from replacing newer live state.
- [x] Keep a contiguous replay cursor separate from higher live event IDs during paginated catch-up.
- [x] Flush short pending deltas on a real 50 ms timer and clear the timer on completion or cancellation.
- [x] Hydrate TUI conversations from structured presentation so persisted provisional tool-turn messages stay hidden.
- [x] Reject bounded polite promise-only finals while preserving substantive quoted examples.
- [x] Treat `model.completed.text` as canonical for the current live attempt.
- [x] Preserve bounded non-delta lifecycle events so long output cannot erase early action history.
- [x] Apply promise-only finalization truth to provider-owned loops and grant stale-snapshot replacement only to paths that reset event subscription.
- [x] Run the complete gate, obtain fresh independent review, push, redeploy, and repeat production pairing/readback.

## v1-next daily-use platform

- [x] Release, tag, publish artifacts, and deploy `v1.0.1`; npm registry publication remains credential-blocked.
- [x] Execute the production dogfood protocol: 20/20 final cases, 20/20 actions, cancellation/resume, and reload/reconnect controls.
- [ ] Persist payload-bound per-action approval requests; ship approve-once/deny/expiry UI and execution readback.
- [ ] Replace crude byte compaction with provider-neutral token budgets, durable provenance, pinned constraints, and atomic tool-call/result groups.
- [ ] Persist and present typed run artifacts with authenticated safe downloads, checksums, citations, PWA cards, and TUI visibility.
- [ ] Integrate feature lanes, reconcile migrations/contracts, and run focused cross-feature tests.
- [ ] Run the complete canonical gate and two independent exact-tree reviews.
- [ ] Merge through GitHub CI, release the integrated version, deploy only with zero active runs, and verify the paired production PWA.
