# Architecture

NUAAI is a local-first personal agent harness. The daemon owns runtime state and every client consumes daemon APIs and events.

```text
Ink TUI / React web client
          │ authenticated HTTP + WebSocket
          ▼
      Node daemon
          ├── AgentRuntime — sessions, runs, provider loop, tools, memory, recovery
          ├── ProviderRegistry — Ollama, Codex CLI, deterministic test provider
          ├── DatabaseStore — SQLite/Drizzle persistence and sqlite-vec retrieval
          ├── Scheduler — durable schedules, task records, restart recovery
          ├── SecretsManager — AES-256-GCM encrypted local records
          ├── SkillRegistry / PluginRegistry
          └── Workspace boundary — path checks, command allowlist, subprocess limits
```

## Runtime flow

1. `nuaai init` creates `.nuaai/` and an idempotent configuration.
2. `nuaai daemon` loads configuration, identity, SQLite state, skills, plugins, providers, and tools.
3. A local daemon lock at `.nuaai/daemon.lock` prevents duplicate ownership. Stale locks are reclaimed only when the recorded PID is no longer alive.
4. The daemon starts the authenticated loopback HTTP gateway, WebSocket event stream, and scheduler.
5. Interactive and scheduled runs use the same `AgentRuntime`, provider contracts, memory retrieval, tools, permissions, cancellation, and durable events.
6. Shutdown closes the scheduler, WebSocket clients, HTTP server, database, and daemon lock.

## Persistence

SQLite stores sessions, threads, messages, runs, events, memories, tasks, schedules, secrets, skills, and plugins. Runtime initialization uses idempotent schema creation. Events are versioned, redacted before persistence, and replayable by cursor through HTTP or WebSocket subscription.

Active queued/running model runs resume on runtime construction. Queued/running scheduled tasks are marked as interrupted on scheduler restart; enabled schedules become eligible for the next poll, providing at-least-once recovery without silently losing task history.

## Provider boundaries

Ollama uses the local HTTP API for streaming chat and embeddings. Codex uses `execa` to invoke the installed CLI with validated `codex exec --json --ephemeral --sandbox read-only --cd <workspace> --skip-git-repo-check [--model <model>] <prompt>` arguments, closes stdin, and ignores non-agent error records in the JSONL stream. The daemon never gives Codex a shell command string. The deterministic provider exists only under `NUAAI_TEST_MODE=1`.

## Client boundary

The TUI and React dashboard never call providers directly. Both use authenticated daemon routes and WebSocket events. The daemon remains the only component allowed to mutate runtime state.
