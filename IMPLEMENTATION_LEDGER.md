# NUAAI v1.0 Implementation Ledger

This ledger records current evidence against `MASTER_PROMPT.md`. `verified` means the named check ran successfully on the current tree. `partial` means implementation exists but a named boundary remains. `pending` means no current evidence exists.

## Baseline

- Target release: `v1.0.0`
- Product version: `1.0.0`
- Local branch: `v1/stabilization`
- Node requirement: 22 or newer
- Runtime architecture: one loopback daemon, authenticated clients, SQLite durability
- Provider architecture: native Ollama and OpenAI-compatible local HTTP modes plus optional direct Codex Responses

## Architecture decisions

1. The daemon is the sole source of runtime truth. TUI, web, CLI, and Matrix remain clients.
2. SQLite owns sessions, messages, runs, events, schedules, tasks, memory, plugin state, and writer claims.
3. Authenticated Web, allowlisted Matrix, and scheduler clients default to explicit operator profiles; read-only remains configurable.
4. Interrupted work fails closed and requires explicit resume; NUAAI does not replay actions automatically after restart.
5. Matrix requires a static user or room allowlist.
6. Codex OAuth remains owned by the installed CLI; model turns use the fixed direct Responses endpoint, while every action remains inside NUAAI's permission-filtered tool loop.
7. Browser E2E uses the production web bundle, real HTTP/WebSocket routes, a real local daemon, and the deterministic test provider.
8. User-service installation is opt-in and does not enable the daemon automatically. The current host service is active and explicitly enabled, with user lingering enabled for boot persistence.
9. Tailscale Serve remains tailnet-scoped and maps Synapse to `/` and NUAAI to `/nuaai`.
10. A local base URL ending in `/v1` selects OpenAI-compatible chat/tools/models/embeddings; other local base URLs use native Ollama APIs.

## Delivery ledger

| Area | State | Current evidence / remaining work |
|---|---|---|
| Runtime contracts and events | verified | Typed perception/decision/action/observation lifecycle, stable permission-filtered tool catalogs, bounded requests, session-filtered replay, cancellation, timeout failure, and provider-action failure tests pass. |
| SQLite and runtime state | verified | WAL persistence, migrations, writer claims, private directory/database modes, and interrupted-run handling pass. |
| Sessions, threads, and queues | verified | Durable lifecycle, manual resume, per-thread serialization, accurate queued counts, and rejection recovery pass. |
| Scheduler and background tasks | verified | Schedules, retries, concurrency, pause/resume, cancellation, and real underlying-run outcome propagation pass. |
| Workspace command boundary | verified | Traversal, symlink, hard-link, project-root read/write limits, generic command allowlist, time/output bounds, and permission tests pass. |
| Secrets and redaction | verified with documented boundary | Secret-manager encryption/tamper/rotation and event redaction pass. Durable transcript/run/memory text is intentionally documented as verbatim local data. |
| Skills and plugins | verified | Filesystem loading, trust validation, capability checks, isolated plugin execution, failure isolation, and registry fallbacks pass. |
| HTTP and WebSocket APIs | verified | Authentication, 1 MiB HTTP body cap, 64 KiB WebSocket cap, session replay filtering, and live browser flows pass. |
| CLI | verified | Init/daemon/status/doctor/run plus actionable dead-daemon output and user-service commands pass local tests. |
| TUI | verified by suite | Daemon-backed conversation, tasks, schedules, memory, skills, plugins, provider controls, navigation, and cancellation tests pass. |
| React PWA | verified | Desktop/mobile viewport fit, authenticated operator status, real daemon-owned workspace write, one final response, persistence, reconnect/error UI, commands, Memory, Automations, System, paired activity IDs, and visible bounded failure causes pass browser and projection tests. |
| Matrix source bridge | verified for text/commands | Generated operator login, temporary private-room invite/join, `/status` response, leave/forget cleanup, and test-device cleanup passed against live Synapse. Media/voice loops remain optional capability-specific checks. |
| Synapse deployment | verified | Compose service restored and pinned to v1.160.0; retained database backed up; local and tailnet Matrix version endpoints return HTTP 200. |
| Tailscale access | verified | Tailnet root Matrix and `/nuaai` web/health return HTTP 200; live 390×844 browser shell has zero overflow and no error surface. No Funnel/public bind is configured. |
| Local provider | verified for chat, lexical memory fallback active | Native Ollama and OpenAI-compatible contracts pass. Live NUAAI → llama.cpp → Nemotron 30B completion returned exact expected output. Both currently running llama.cpp servers return 501 for embeddings, so automatic and manual recall use tested lexical mode. |
| Codex provider | verified | Direct Responses transport, fixed-host/redirect policy, independent model selection, visible CLI-cache catalog, bounded/redacted SSE errors, Codex-owned credential refresh, 48-call budget/finalization, and thread-scoped `run.history` pass. The exact requested code review completed live with 22 paired tool calls and lexical recall; live self-diagnosis returned the exact prior failure cause. |
| Dependency state | verified with accepted low | `npm ls --all` passes. Audit has 0 moderate/high/critical advisories and one dev-only low Windows esbuild advisory under tsup. |
| Release publication | release-gated | The release branch, GitHub PR, `v1.0.0` tag, GitHub Release, and attached tarball must resolve to the verified commit. npm registry publication is outside this release. |

## Current local quality evidence

- Vitest: 239 tests passed.
- Scoped per-file V8 coverage is above the enforced 80% floor; current aggregate results are statements 94.23%, branches 85.92%, functions 95.54%, and lines 96.95%.
- Playwright: three production-bundle flows passed: the full desktop/mobile workflow, inactive-provider failure scoping, and mobile safe-area geometry.
- Biome formatting and lint: passed.
- TypeScript, Node build, web build, package dry-run, clean tarball install, installed-daemon/browser-pairing/skill smoke, and canonical `npm run gate`: passed on Node 22.22.2 after the final release changes.
- Live systemd service, local/Tailscale HTTP, Matrix `/status`, and local-model completion checks passed.

## Completion rule

Do not mark publication complete from local evidence. Completion requires the final canonical local gate, final package-install smoke, independent diff review, green GitHub PR and tag checks, a verified GitHub Release, and post-publication service/artifact verification. A model-server embedding mode remains a separate operator decision, not a silent release action.
