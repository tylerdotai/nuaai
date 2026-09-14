# Changelog

All notable NUAAI changes are recorded here.

## [Unreleased]

### Added

- First-class durable run artifacts with stable run/thread ownership, supported file/diff/test-report/screenshot/citation/deployment-receipt contracts, bounded redacted provenance, immutable private storage, and verified SHA-256 checksums.
- Runtime capture for explicit structured tool artifacts, successful `workspace.write` output, and web citations, with independent `artifact.created` / `artifact.failed` events so optional capture cannot turn a successful tool into a failure.
- Authenticated artifact list, detail, and byte-range download routes with cross-run 404 isolation, safe attachment headers, mount-relative PWA links, assistant-run artifact cards, distinct citations, and concise TUI visibility.

### Security

- Artifact capture rejects traversal, absolute paths, symlinks, hard links, protected runtime/credential paths, unsupported kind/MIME pairs, oversized content/metadata, and non-HTTPS or credential-bearing URLs. Text checksums cover stored sanitized bytes and are labeled accordingly.

## [1.0.1] - 2026-09-14

### Fixed

- Long provider responses now retain only the current model attempt, batch token-sized deltas, persist an authoritative reconnect snapshot, and survive bounded event replay without clipping or concatenating discarded drafts.
- Substantive final answers are no longer rejected for quoting future-intent examples; genuine model-turn exhaustion receives one no-tools grace turn before a truthful terminal failure.
- The existing tool registry now owns explicit governance metadata, profile approval integrity, weighted and per-tool budgets, pre-execution admission, durable policy audit events, and execute-level protection for computer control.
- Configured MCP tools now stay behind the stable registry discovery/execution pair instead of being duplicated into provider catalogs.
- Generated output is bounded across the whole run rather than per model attempt, and short deltas flush to the durable live snapshot on a real 50 ms timer.
- Browser replay now uses a session-wide watermark, buffers and orders paginated catch-up, rejects duplicate events, and refuses stale background snapshots that would overwrite newer live output.
- Browser completion text is canonical for the current attempt, TUI refreshes use the structured conversation projection, and bounded polite promise-only replies receive the existing finalization correction.
- Long output no longer evicts early tool lifecycle records from browser presentation or run-state, preserving truthful action history alongside bounded recent deltas.
- Provider-owned loops now receive the same promise-only finalization truth checks, and same-thread send/retry snapshots cannot replace live state unless their watermark is current.

### Verification

- Vitest: 328 tests across 34 files passed.
- Playwright: 8 built-web browser flows passed, including long multi-attempt streaming and reload.
- Package smoke: clean tarball install, CLI initialization, daemon health, and shutdown passed.
- Live production stress: one 48,110-character final response survived five model attempts, 19 paired actions, 2,499 streamed delta events, browser process loss, re-pairing, and completed-state reload without clipping, duplication, or a false tool-turn failure.
- Independent exact-hash runtime and browser reviewers passed with zero remaining findings.

## [1.0.0] - 2026-09-14

### Added

- Viewport-bound responsive PWA with durable conversation/thread selection, one authoritative streamed response, run activity, Memory, Automations, System, reconnect/error states, keyboard commands, and mobile navigation.
- Opt-in user-service commands: `install`, `start`, `stop`, `restart`, and `status`. Installation does not start or enable the daemon.
- Tailscale onboarding route plan for Synapse at `/` and NUAAI at `/nuaai`.
- OpenAI-compatible `/v1` mode for local chat, tool calls, embeddings, and model discovery while retaining native Ollama APIs.
- Real browser E2E assertions for desktop/mobile geometry, persistence, cancellation, tools, automation outcomes, section navigation, and browser errors.
- Explicit browser pairing through a five-minute, fragment-based `nuaai pair` URL that exchanges for a separate mount-scoped browser session; loading the static shell no longer bootstraps an authenticated cookie.
- Installed-tarball release smoke covering the packaged CLI, daemon, web bundle, browser pairing, authenticated APIs, and all first-party skills.
- Thread-scoped `run.history` tool for bounded model-visible diagnosis without exposing the private runtime database or cross-session data.

### Changed

- Authenticated Web, allowlisted Matrix, and scheduled runs default to configurable operator permissions; read-only remains an explicit profile.
- Codex model turns use the direct ChatGPT Codex Responses endpoint with CLI-owned OAuth; actions use the same NUAAI permission-filtered tool loop as local providers.
- Interrupted runs are marked failed and require explicit resume instead of replaying work automatically.
- Matrix requires a static user or room allowlist when enabled.
- Onboarding starts only selected integration services, installs the pinned Playwright runtime when requested, and keeps Synapse public registration disabled.
- Ordinary assistant responses no longer enter durable memory automatically; memory writes remain explicit.
- Runtime identity tokens rotate after expiration.
- The default per-run tool budget is 48 calls; budget exhaustion now forces a no-tools finalization turn from completed evidence.
- The release gate now runs formatting/lint, strict TypeScript, 80% per-file coverage over its documented runtime/core scope, fresh Node/web builds, browser E2E, installed-package smoke, version checks, and moderate-or-higher dependency audit enforcement.

### Fixed

- Restored the deleted Synapse Compose service, pinned Synapse v1.160.0, and pinned every local integration image by immutable registry digest.
- Automatically loads generated `.nuaai/matrix.env` without overriding explicit process environment values.
- Scheduled tasks now fail when the underlying agent run fails or is cancelled.
- Run timeouts are reported as failures with timeout context instead of cancellations.
- Provider-owned action failures can no longer produce successful runs.
- WebSocket replay filters by subscribed session and inbound WebSocket/HTTP payloads are bounded.
- Per-thread queued-run counts now remain correct while a writer is active and after a rejected run.
- Generic command paths stay within the project root; interpreter/package-manager/provider executables are not exposed through the generic command tool.
- Workspace writes refuse symlink and hard-link targets; runtime/database files use owner-only permissions.
- CLI daemon failures now name the unreachable endpoint and recovery command instead of only printing `fetch failed`.
- Hono and Vitest/coverage patch updates remove all moderate-or-higher dependency advisories.
- Replaced the non-completing Codex CLI/App Server model-turn path with fixed-host streaming Responses, provider-safe tool-name mapping, structured function-call replay, bounded/redacted SSE errors, and Codex-owned near-expiry credential refresh.
- Removed the dormant App Server turn adapter and its test-only integration surface after production routing moved to direct Responses; the Codex CLI remains only for login, model metadata, credential refresh, and the existing compatibility adapter.
- Codex Responses now cancels unfinished success and error bodies and unlocks SSE readers, preventing per-turn connection leakage in long-running sessions and repeated HTTP failures.
- Serialized Matrix status reactions prevent duplicate-reaction errors during rapid run events.
- Matrix checkpoints advance only after handlers complete; deterministic transaction IDs and stable event keys make run, command-response, and `/new` retries idempotent.
- Daemon ownership is acquired atomically before runtime mutation, queued context is loaded at execution time, and shutdown aborts active/nested work before draining.
- Protected paths now include trusted extension/runtime state, Git metadata, and credential-like project files; workspace commands reject symlink/path escapes, mutating or indirect-read options, unsafe process listings, and ambient environment inheritance.
- Every model-triggered child process—including Codex, media/audio helpers, MCP, workspace commands, plugins, and external agents—receives an explicit minimal environment instead of inheriting daemon credentials.
- Existing databases archive duplicate legacy Matrix source bindings before installing unique ownership indexes, preserving upgrade startup.
- Provider tools now remain stable across turns instead of depending on brittle lexical routing; authenticated operator clients expose typed write/execute tools and reject only calls outside the permission-filtered catalog.
- Per-provider model selections persist independently; local catalogs remain live-discovered, and Codex exposes only visible models from the authenticated CLI cache.
- The outer run timeout now exceeds the Codex turn timeout, Matrix retries bounded `429` responses with the same transaction ID, reaction churn is reduced, and provider stderr cannot persist unbounded remote response bodies.
- Browser and page-fetch tools reject credential-bearing, unsafe-port, local, private, link-local, mixed-DNS, redirect, and private-subresource destinations; arbitrary model-facing fetches no longer delegate redirects to Crawl4AI or FlareSolverr.
- Read-only runs can no longer persist learned skills; durable learning requires write permission and filesystem capability.
- An unavailable inactive provider now stays scoped to its provider card and a brief status notice; the healthy active runtime no longer triggers the global failure alert.
- Mobile layout rows now reserve the real device safe-area inset so bottom navigation, drawers, scrims, and alerts cannot cover System content.
- Automatic memory retrieval now falls back to lexical ranking when embeddings are unavailable or return no matches.
- Exceptional run failures are persisted as assistant context, runtime-owned tool events share stable call IDs, and the PWA displays bounded failure causes while reconciling legacy id-less tool events.

### Verification

- Vitest: 302 tests across 34 files passed in the canonical Node 22 release gate.
- Scoped per-file V8 coverage aggregate results: statements 94.50%, branches 86.04%, functions 96.01%, lines 97.15%.
- Node and web production builds: passed.
- Playwright built-web E2E: 7 flows passed, covering the full desktop/mobile workflow, inactive-provider failure scoping, mobile safe-area geometry, stale terminal-poll ownership, accepted-run refresh failure, and invalid/transient pairing cleanup.
- Clean tarball install, installed CLI initialization, daemon health, graceful shutdown, port cleanup, and lock cleanup: passed.
- Package graph: valid.
- Dependency audit: 0 moderate, high, or critical advisories; one accepted dev-only low advisory in tsup's Windows development-server dependency.
- Live service: systemd active, local and Tailscale NUAAI HTTP 200, local and Tailscale Matrix HTTP 200, and no post-restart journal errors.
- Live Matrix: generated operator login, private-room invite/join, `/status` response, room cleanup, and disposable device cleanup passed.
- Live local model: NUAAI completed an authenticated API turn through llama.cpp and Nemotron 3.5 Lightning 30B with exact expected output. The currently running llama.cpp servers do not expose embeddings.
- Codex Responses: direct endpoint probe, authenticated Sol completion, live `workspace.list`, live `workspace.write` → `workspace.read`, and the exact requested code review completed. The review used 22 paired tool calls and lexical memory retrieval. A live `run.history` follow-up returned the exact prior failure cause.

## [0.1.0] - 2026-08-15

### Added

- Persistent SQLite-backed sessions, threads, runs, events, memories, tasks, schedules, secrets, skills, and plugins.
- Ollama streaming chat and embedding provider with modern and legacy embedding API support.
- Controlled Codex CLI subprocess provider with JSONL parsing, read-only sandbox arguments, timeout, cancellation, and fake-executable coverage.
- Deterministic provider mode for local automated tests.
- Authenticated loopback HTTP and WebSocket gateway.
- Ink TUI and daemon-backed React dashboard, including Ctrl-arrow session/thread navigation, message hydration, schedule editing, and provider/model controls.
- AES-256-GCM secret storage, redaction, workspace path protection, command allowlists, and output limits.
- Durable schedule lifecycle with startup, one-shot, interval, cron, and manual triggers, bounded retries/backoff, missed-run policy, per-schedule concurrency limits, task inspection/cancellation, and restart recovery.
- Daemon lock ownership and restart recovery for active model runs and scheduled tasks.
- Built-web Playwright browser E2E coverage.

### Verification

- Vitest: 40 tests passed.
- Strict per-file V8 coverage: statements 96.00%, branches 87.17%, functions 98.23%, lines 98.00%.
- Node and web production builds passed.
- Playwright built-web E2E passed.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- Real Ollama chat and embedding smoke passed on the local runtime.
- Codex CLI health and fake subprocess contract passed. Hosted Codex generation was not run; local OSS smoke reached the CLI but small local models returned unsupported tool output or timed out.
