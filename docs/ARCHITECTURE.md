# Architecture

NUAAI is a local-first personal agent harness. The daemon owns runtime state and every client consumes daemon APIs and events.

```text
Ink TUI / React web client
          │ authenticated HTTP + WebSocket
          ▼
      Node daemon
          ├── AgentRuntime — sessions, runs, provider loop, tools, memory, recovery
          ├── ProviderRegistry — native Ollama, OpenAI-compatible local, Codex Responses, deterministic test
          ├── DatabaseStore — SQLite/Drizzle persistence with semantic and lexical retrieval
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

## Agentic loop

1. **Perception:** an authenticated Web, Matrix, CLI, TUI, or scheduler request enters a durable thread and captures current context.
2. **Decision:** the selected provider receives the layered system prompt plus one stable tool catalog filtered by the client permission profile.
3. **Action:** a structured provider tool call is validated against the advertised catalog and executed once through the daemon-owned registry.
4. **Observation:** the bounded tool result is persisted as internal execution metadata and returned to the provider with the assistant tool-call message. Separately, explicit structured artifact candidates, successful workspace writes, and web sources are validated and captured as first-class run artifacts.
5. **Continuation:** the loop repeats until a verified final response, explicit failure, cancellation, timeout, configured turn limit, or an action requiring approval. Profile-governed actions create a durable payload-bound request and set the same run to `paused`; approval revalidates authority and resumes that run, while denial or expiry ends it without executing the action. Exhausting the tool budget disables further tools and requests a final answer from gathered evidence.
6. **Approval:** each request binds the run ID, canonical registry tool name, and canonical arguments into a SHA-256 hash. SQLite stores the hash plus redacted bounded operator previews—not raw arguments—and atomically consumes an approved request once immediately before execution. Pending requests survive daemon restart; a resumed provider must propose the exact same payload hash before execution.
7. **Commit:** authoritative output and lifecycle evidence are written by the active thread writer and projected to connected clients.

Before each provider turn, the runtime applies a provider-neutral token budget using a deterministic UTF-8 estimator. It reserves system-prompt, tool-schema, current-input, and response headroom; keeps project/session constraints and pinned memory; selects recent complete turns; and treats each structured assistant tool-call artifact plus all matching tool-result messages as one atomic group. Incomplete groups and orphan tool rows never cross the provider boundary.

## Persistence

SQLite stores sessions, threads, messages, runs, run-artifact records, events, memories, tasks, schedules, secrets, skills, and plugins. Runtime initialization uses idempotent schema creation. Events are versioned, redacted before persistence, and replayable by cursor through HTTP or WebSocket subscription.

Run artifacts have stable IDs and remain bound to exactly one run and thread. Stored bytes are copied once into owner-only `.nuaai/artifacts/<run-id>/` paths; SQLite records the stored byte length and SHA-256 checksum. Text-like content is redacted before the immutable copy is written, and artifact provenance records that the checksum covers stored sanitized bytes rather than claiming byte-for-byte identity with the workspace source. Citation-only records instead checksum the canonical HTTPS URL payload. The legacy `message_artifacts` table remains internal transcript/tool-loop metadata and is not used as an artifact store.

Token pressure creates a durable deterministic extractive checkpoint without deleting transcript rows. Each checkpoint records source start/end message IDs, source message count, canonical source SHA-256 and provenance version, estimated original/summary tokens, checkpoint version, and update time. Rolling checkpoints retain previously selected records when possible, never cut a UTF-8 string or source record, and produce identical provider context after restart. `context.compacted` and `context.selected` events expose counts and token estimates only, never message content.

Active queued/running model runs are marked failed on runtime construction and require explicit manual resume, preventing automatic action replay. Exceptional terminal failure text is also persisted as an assistant message so the next turn can identify the actual cause. Queued/running scheduled tasks are marked interrupted on scheduler restart; enabled schedules become eligible for the next poll without silently losing task history.

Automatic memory retrieval first attempts the configured Ollama embedding provider. Missing or empty semantic results fall back to bounded lexical ranking over durable memory records. The read-only `run.history` tool exposes only recent outcomes from the current thread and omits internal correlation data.

## Provider boundaries

Ollama uses the local HTTP API for streaming chat and embeddings. Codex turns use the fixed HTTPS ChatGPT Codex Responses endpoint with OAuth state read on demand from the installed Codex CLI. NUAAI never copies OAuth state into project configuration or SQLite. When an access token nears expiry, NUAAI invokes a short-lived, sanitized `codex app-server` account RPC so Codex refreshes its own store; model turns do not use App Server. Responses function calls normalize into the same daemon-owned, permission-filtered tool loop as local providers. Visible model IDs come from Codex's local model cache, and independent provider selections survive restarts. The deterministic provider exists only under `NUAAI_TEST_MODE=1`.

## Client boundary

The TUI and React dashboard never call providers directly. Both use authenticated daemon routes and WebSocket events. The daemon remains the only component allowed to mutate runtime state. Artifact list, detail, and byte-range download routes validate run ownership; web download URLs are mount-relative so a `/nuaai` deployment cannot escape to the origin root. The structured thread presentation attaches artifacts and citations only to their owning assistant run.
