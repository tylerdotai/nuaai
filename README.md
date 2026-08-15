# NUAI

**not ur avg ai**

NUAI is a local-first personal AI agent harness. A Node daemon owns durable runtime state; the Ink TUI and React web client consume daemon APIs and WebSocket events instead of duplicating agent logic.

## What is included

- Durable SQLite sessions, threads, messages, runs, events, tool calls, memory, secrets, and schedules
- Observe → plan → act runtime loop with streaming output, tool execution, limits, cancellation, timeout handling, and restart recovery
- Ollama chat and embedding adapters using the local HTTP API
- Codex CLI adapter using the installed `codex exec --json` subprocess boundary
- Deterministic provider for repeatable local tests, enabled only with `NUAI_TEST_MODE=1`
- SQLite vector storage/search through sqlite-vec when available, with honest embedding-unavailable behavior
- AES-256-GCM encrypted secrets with rotation and redacted API/UI output
- Safe workspace filesystem operations, traversal/symlink protection, command allowlists, and subprocess limits
- Validated filesystem skills and trusted plugin manifests
- Durable one-shot, interval, and cron schedules with manual/startup triggers, retries/backoff, missed-run policy, per-schedule concurrency limits, task inspection/cancellation, and restart recovery
- Local daemon lock ownership prevents duplicate daemon instances
- Authenticated loopback HTTP and WebSocket gateway
- Ink terminal client and daemon-backed React dashboard
- Playwright browser E2E against the built web UI and a real local daemon

## Requirements

- Node.js 20 or newer
- Ollama is optional for deterministic tests and required for the default local chat/embedding provider
- Codex CLI is optional and required only when using the Codex provider

## Setup

```bash
npm install
npm run gate
npm run build
npm run build:web
```

Initialize a workspace and start the daemon:

```bash
node dist/cli.js init
node dist/cli.js daemon
```

The daemon binds to `http://127.0.0.1:8787` by default. Runtime state is stored under `.nuai/`, including the SQLite database, configuration, encrypted secrets, local authentication metadata, and `daemon.lock`. Authentication material is generated locally and is not checked into Git.

## Configuration

`nuai init` creates `.nuai/config.json`. Defaults are:

```json
{
  "version": 1,
  "name": "NUAI",
  "host": "127.0.0.1",
  "port": 8787,
  "provider": {
    "name": "ollama",
    "model": "qwen3.5:latest",
    "baseUrl": "http://127.0.0.1:11434"
  },
  "embedding": {
    "model": "nomic-embed-text:latest",
    "baseUrl": "http://127.0.0.1:11434"
  }
}
```

For a repeatable local smoke path:

```bash
NUAI_TEST_MODE=1 node dist/cli.js daemon
```

This selects the deterministic provider and returns `NUAI deterministic test response`; it does not fabricate responses in the normal Ollama or Codex paths.

## Commands

```bash
npm run dev              # CLI through tsx
npm run dev:server       # daemon server through tsx
npm run dev:web          # Vite development web client
npm run check            # Biome plus strict TypeScript
npm test                 # Vitest unit/integration suite
npm run test:coverage    # V8 coverage; strict per-file thresholds are 80% for every metric
npm run test:e2e         # Playwright built-web browser smoke test
npm run gate             # version, check, tests, Node build, web build
npm run version:check    # package version versus latest Git tag
```

## TUI controls

The Ink client is daemon-backed; it never runs a second agent runtime.

- `Ctrl+1` through `Ctrl+8`: switch surfaces; `Ctrl+0` opens the command palette.
- `Ctrl+Up` / `Ctrl+Down`: select and hydrate sessions.
- `Ctrl+Left` / `Ctrl+Right`: select and hydrate threads in the active session.
- `Ctrl+N` on Schedules: create a schedule with `name|type|expression|agent input`.
- `Ctrl+Shift+E` on Schedules: edit the first listed schedule with `id|name|type|expression|agent input`.
- `Ctrl+G`: trigger the first listed schedule; `Ctrl+E`: pause/resume it.
- `Ctrl+P` / `Ctrl+M`: cycle provider/model; `Ctrl+X`: cancel the active run/task.
- `Ctrl+R`: refresh daemon state; `Esc`: exit.

## Architecture

```text
Ink TUI / React web client
            │ HTTP + authenticated WebSocket
            ▼
        Node daemon
            │
            ├── AgentRuntime — sessions, runs, events, tools, memory, recovery
            ├── ProviderRegistry — Ollama, Codex, deterministic test provider
            ├── DatabaseStore — SQLite/Drizzle persistence and vector rows
            ├── Scheduler — durable background runs
            ├── SecretsManager — encrypted local secret records
            ├── SkillRegistry / PluginRegistry
            └── Workspace boundary — safe files and subprocesses
```

The daemon is the source of truth. Clients do not call providers directly or maintain independent agent state.

## Security boundaries

- Gateway routes require the generated local token through a bearer header or HttpOnly cookie.
- WebSocket connections validate the same token.
- Workspace paths are resolved and checked against the workspace root, including symlink escapes.
- Commands are restricted to an explicit allowlist and bounded by timeout/output limits.
- Secret values are encrypted at rest and omitted from list/status/event responses.
- No credentials, runtime tokens, `.env` files, or generated `.nuai/` state belong in Git.

## Verification

The current acceptance suite includes:

- Biome formatting/lint checks
- Strict TypeScript typechecking
- Vitest unit and integration tests
- V8 strict per-file coverage thresholds of at least 80% for statements, branches, functions, and lines
- Node and web production builds
- Playwright browser E2E against the built web client and real daemon
- npm dependency audit
- Package/tag version consistency check

Real provider verification is separate from deterministic browser testing. The installed Ollama chat and embedding smoke paths passed, and a live hosted Codex `AgentRuntime` smoke completed with persisted output `NUAI_RUNTIME_CODEX_OK`. Codex authentication and billing remain external provider state; deterministic browser tests never spend provider quota.

No public deployment or remote daemon exposure is required; the supported runtime is local loopback.

## Versioning

The package version and latest Git tag must match:

```text
package.json 0.1.0
Git tag       v0.1.0
```

Run `npm run version:check` before creating the next release tag.

## Detailed documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`docs/SCHEDULER.md`](docs/SCHEDULER.md)
- [`CHANGELOG.md`](CHANGELOG.md)