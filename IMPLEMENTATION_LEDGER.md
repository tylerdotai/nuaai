# NUAI Implementation Ledger

This ledger records implementation evidence against `MASTER_PROMPT.md`. `verified` means the acceptance evidence ran successfully. `partial` means real work exists but a required acceptance item or feature remains incomplete. `pending` means no sufficient evidence exists yet.

## Baseline

- Repository: `/home/tyler/nuai`
- Starting commit: `ec383cb`
- Starting tag: `v0.1.0`
- Product version: `0.1.0`
- Branch: `main`
- Node: 20+ required by project; current command runtime is Node 26.7.0
- Ollama: `0.20.3`
- Installed Ollama models: 10, including `qwen3.5:latest` and `nomic-embed-text:latest`
- Codex: `codex-cli 0.147.0`
- Codex non-interactive command: `codex exec --json`

## Architecture decisions

1. The daemon is the runtime source of truth. TUI and web clients are event-driven clients.
2. SQLite is the local durable store. SQLite-backed scheduling avoids an unnecessary queue service.
3. Ollama uses its local HTTP API through a small native `fetch` adapter.
4. Codex uses a controlled `execa` subprocess adapter and verified `codex exec --json` behavior.
5. HMAC tokens authenticate local HTTP/WebSocket access. Generated authentication metadata lives in `.nuai/runtime.json`.
6. AES-256-GCM encrypts provider secrets. The master key comes from `NUAI_MASTER_KEY` or the local restrictive `.nuai/master.key` path.
7. Skills and plugins use manifests and validated capabilities. Untrusted code is refused.
8. Browser E2E uses Playwright against the built web client and a real deterministic local daemon. External provider smoke tests remain separate and truthful.
9. A local `.nuai/daemon.lock` prevents duplicate daemon ownership and reclaims stale PID records.

## Delivery ledger

| Area | State | Evidence / remaining work |
|---|---|---|
| Runtime contracts/events | verified | Versioned event types, redaction, persistence, replay, and integration coverage pass. |
| SQLite schema/initialization | verified | Durable idempotent initialization, explicit `schema_meta` versioning, v1→v2 schedule-policy migration, v2→v3 plugin-column migration against a legacy database, and sqlite-vec tests pass. |
| Daemon lifecycle | verified | Loopback daemon smoke, graceful stop, SIG handlers, startup error path, and duplicate-lock test pass. |
| Sessions/threads/runs | verified | Durable lifecycle, cancellation, resumption, and restart recovery tests pass. |
| Ollama adapter | verified | Real local chat returned streamed `OLLAMA_SMOKE_OK`; `nomic-embed-text:latest` returned a 768-dimensional vector. |
| Codex adapter | verified | Controlled `execa` subprocess with JSONL parsing, empty-stdin closure, abort/timeout handling, read-only sandbox, non-Git workspace support, explicit-model omission when unset, fake-executable coverage, and a live hosted Codex `AgentRuntime` smoke that completed and persisted `NUAI_RUNTIME_CODEX_OK`. |
| Agent loop | verified | Deterministic streaming, memory retrieval, tool loop, limits, failures, timeout/cancellation paths pass. |
| Encrypted secrets | verified | AES-GCM, tamper rejection, rotation, permissions, redaction, and API wiring pass. |
| Secure workspace tools | verified | Traversal, symlink, allowlist, timeout, output capture, and permission tests pass. |
| Memory/vector retrieval | verified | Real sqlite-vec extension path and Ollama embedding integration pass. |
| Scheduler/background agents | verified | All five schedule types, persistence, pause/resume, manual trigger, lifecycle tasks, duplicate-trigger prevention, bounded retries with exponential backoff, missed-run skip policy, per-schedule concurrency limits, task inspection/cancellation with provider-run propagation, restart recovery, and local daemon lock ownership pass. |
| Skills | verified | Filesystem manifest loading, trust validation, compilation, registration, and dispatch tests pass. |
| Plugins | verified | Trusted manifests, API/dependency/version validation, safe entry-path checks, isolated child-process execution with timeout/output bounds, configuration, enable/disable/reload/unload, durable SQLite state, refusal health, and failure isolation pass. |
| HTTP API | verified | Authenticated daemon routes, sessions, runs, schedules, secrets, providers, and health are exercised. |
| WebSocket API | verified | Authenticated subscription, cursor replay, live events, filtering, and browser persistence path pass. |
| Ink TUI | verified | Daemon-backed TUI has live conversation, tasks, schedules, memory, skills, plugins, settings/provider-model selection, help, command-palette views, schedule creation/editing through authenticated POST/PUT routes, Ctrl-arrow session/thread selection with message hydration, schedule trigger/pause/resume, task/run cancellation, catalog hydration, reducer/parser tests, and non-TTY/PTY launch smoke pass. |
| React web UI | verified | Built UI connects to real daemon state, streaming events, cancellation, persistence, live memory/skills/plugin records, dashboard views, and schedule/task management. |
| Browser E2E | verified | Playwright built-web smoke passes 1/1. |
| Dependency cleanup | verified | Locked install state, package usage review, and `npm audit --audit-level=low` report 0 vulnerabilities. |
| Documentation | verified | README, architecture, configuration, security, scheduler, changelog, and this ledger are synchronized with current evidence. |
| Release gate | verified | Biome, strict TypeScript, 40 Vitest tests, strict per-file coverage, Node/web builds, built-web E2E, audit, and version check pass. Human-authored release commit and annotated `v0.1.0` tag point to the verified tree; clean-tree check passes. |

## Current quality evidence

- Vitest: 40 passed.
- Strict per-file V8 coverage: statements 96.00%, branches 87.17%, functions 98.23%, lines 98.00%.
- Node build: passed after plugin isolation, durable plugin-schema, TUI schedule-editor, and TUI selection changes.
- Web build: passed after plugin isolation, durable plugin-schema, TUI schedule-editor, and TUI selection changes.
- Playwright: 1 passed against the built web UI and deterministic daemon.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- `git diff --check`: passed.
- Daemon cleanup: no active daemon process and no `.nuai/daemon.lock`.

## Rule

Do not mark an area complete from source inspection. Keep partial states when required behavior is missing or an external acceptance path is blocked. Never fabricate provider output, hosted usage, coverage, or release state.
