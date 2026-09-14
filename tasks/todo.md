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
