# Changelog

All notable NUAI changes are recorded here.

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
