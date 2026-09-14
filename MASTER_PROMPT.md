# NUAAI Master Build Prompt

> Point the implementation agent to this file when starting or resuming NUAAI work.
>
> Example:
>
> ```text
> Read and execute `<repository-root>/MASTER_PROMPT.md` completely. Continue from the current repository state. Do not stop at a plan or scaffold.
> ```

## Mission

Build NUAAI — **not ur avg ai** — into a complete, working, persistent personal AI agent harness.

NUAAI is not a one-off task runner, demo, mock, placeholder, generic CLI wrapper, or MVP exercise. NUAAI is a local-first personal agent operating environment with:

```text
persistent daemon
  ├── sessions and threads
  ├── resumable agent runs
  ├── Observe → Plan → Act runtime
  ├── Ollama provider
  ├── OpenAI Codex provider
  ├── encrypted secrets
  ├── durable memory and vector retrieval
  ├── scheduled background agents
  ├── secure tools
  ├── skills and plugins
  ├── versioned event bus
  ├── authenticated HTTP API
  ├── authenticated WebSocket stream
  ├── full Ink TUI client
  └── full React web client
```

The implementation target is the existing repository:

```text
<repository-root>
```

Continue from the current repository state. Preserve useful work. Do not replace the repository wholesale.

## Non-Negotiable Product Requirements

- Product name: `NUAAI`
- Product tagline: `not ur avg ai`
- Runtime workspace: `.nuaai/`
- Persistent daemon, not one-off process execution
- Full TUI, not a terminal demo
- Full web UI, not a static shell
- Ollama integration using the available local Ollama runtime
- OpenAI Codex integration using the installed Codex CLI or verified Codex-compatible interface
- Durable sessions, threads, messages, runs, events, tasks, memory, skills, plugins, and configuration
- Scheduled background agents
- Encrypted secrets at rest
- Plugin and skill system
- Mandatory browser end-to-end testing
- Minimum 80% coverage across every measured source module, provider adapter, runtime model, database service, plugin service, skill service, and utility
- No fake production data
- No fake model output
- No placeholder integrations presented as complete
- No silent error handling
- No warnings or errors in the final quality gate
- No unnecessary external dependencies
- No scope reduction to an MVP
- No stopping after scaffolding, planning, interfaces, or a passing compile

## Execution Rules

1. Inspect the repository, Git state, package manifest, lockfile, tests, installed dependencies, installed Ollama runtime, and installed Codex CLI before editing.
2. Read relevant source files completely before changing behavior.
3. Read the current `AGENTS.md`, README, configuration, and test setup if present.
4. Verify external tool capabilities instead of guessing CLI syntax or API behavior.
5. Build the complete product in dependency order, but continue through every phase in this goal without waiting for another confirmation.
6. Ask only when a missing decision materially changes architecture, requires credentials, or requires an external state-changing action.
7. Internal source edits, local builds, local servers, local databases, local browser tests, and local `.nuaai` initialization are authorized.
8. Do not push, publish, deploy publicly, send messages, enable remote access, modify billing, or change production services without explicit approval.
9. Do not delete user data or destructive files. Use safe deletion methods when cleanup is authorized.
10. Do not fabricate command flags. Inspect `ollama --help`, `codex --help`, package documentation, or installed type definitions.
11. Do not add an external package merely for convenience. Prefer Node built-ins, existing project dependencies, SQLite, and small local modules.
12. Every added dependency must have a documented reason, an exercised code path, a compatible lockfile entry, and no unused import or unused package residue.
13. Do not weaken tests, remove coverage gates, hide source files from coverage, or convert real integrations into mocks to make the gate pass.
14. Keep implementation low-code and surgical. No speculative abstractions or duplicate runtime logic.
15. Do not report completion based on code existence. Completion requires real execution evidence.
16. Do not provide time estimates. Work to completion or report a precise blocker with evidence.

## Required Technology Boundaries

Use the existing project stack where a real requirement exists:

- Node.js and TypeScript
- ESM
- Vercel AI SDK for model-agnostic model streaming where compatible
- Ollama provider integration
- OpenAI Codex adapter through the installed CLI's OAuth state and a verified Codex-compatible interface
- `better-sqlite3`
- `sqlite-vec`
- `drizzle-orm`
- Hono and `@hono/node-server`
- `ws` or the smallest compatible WebSocket boundary already present
- `node:crypto` for HMAC and encryption
- Ink and React for the TUI
- Vite and React for the web UI
- Zod for runtime schemas
- `ts-morph` and `esbuild` for validated skill/plugin generation where required
- `execa` for controlled subprocess execution
- `fast-glob` for bounded workspace/plugin/skill discovery
- `diff` for patch review
- Biome and TypeScript for static quality
- Vitest and `@vitest/coverage-v8` for unit/integration coverage
- Playwright for mandatory browser E2E

Do not keep a dependency only because the initial scaffold listed the package. Remove unused packages after verifying that removal does not break a required runtime boundary. Do not replace required functionality with a dependency that adds no material value.

## Complete Repository Shape

Use a clear structure close to this shape, adapting only when the current repository proves a better location:

```text
.config/
  harness.config.ts
.nuaai/                         # runtime-created and Git-ignored
src/
  cli.tsx                      # TUI entrypoint and client commands
  daemon.ts                    # long-lived daemon entrypoint
  server.ts                    # HTTP and WebSocket API
  config/
    schema.ts
    loader.ts
    migrations.ts
  core/
    agent.ts                    # persistent Observe → Plan → Act runtime
    session.ts                  # session/thread/run lifecycle
    events.ts                   # versioned event contracts
    scheduler.ts                # durable background-agent scheduler
    queue.ts                    # bounded local task queue
    cancellation.ts
    recovery.ts
  providers/
    types.ts
    registry.ts
    ollama.ts
    codex.ts
    health.ts
  gateway/
    http.ts
    websocket.ts
    token.ts
  memory/
    db.ts
    schema.ts
    embeddings.ts
    vector.ts
    retrieval.ts
  security/
    secrets.ts
    encryption.ts
    redaction.ts
    permissions.ts
  skills/
    registry.ts
    loader.ts
    validator.ts
    synthesizer.ts
    built-in/
  plugins/
    manifest.ts
    registry.ts
    loader.ts
    permissions.ts
    lifecycle.ts
  workspace/
    fs.ts
    commands.ts
    patches.ts
    scanning.ts
  web/
    ...
  ui/
    ...
tests/
  unit/
  integration/
  providers/
  daemon/
  websocket/
  scheduler/
  security/
  plugins/
  skills/
  browser/
playwright.config.ts
vitest.config.ts
biome.json
package.json
README.md
CHANGELOG.md
```

The final tree does not need to match this list exactly, but every required responsibility must have a real implementation and tests.

## `.nuaai` Runtime Workspace

The runtime workspace must initialize safely and idempotently below `.nuaai/`:

```text
.nuaai/
  config.json
  runtime.json
  memory.db
  sessions/
  skills/
  plugins/
  schedules/
  logs/
  cache/
  secrets/
```

Requirements:

- `.nuaai/` is Git-ignored.
- Directory initialization is safe to repeat.
- Configuration has a schema and version.
- Configuration migrations are explicit and tested.
- Corrupt configuration fails clearly.
- Runtime paths cannot escape the workspace root.
- Symlink escape is rejected for protected file operations.
- Runtime state survives daemon restart.
- Secrets never appear in `.nuaai` as plaintext.
- Logs are bounded and redacted.
- The workspace can be inspected through the TUI and web UI.

## Persistent Daemon

Implement a real long-running command:

```text
nuaai daemon
```

The daemon must:

- initialize `.nuaai/`
- open the database
- load configuration, plugins, and skills
- recover interrupted sessions and scheduled tasks
- start HTTP and WebSocket servers
- manage all agent runs
- keep background agents alive
- expose provider health
- support graceful shutdown
- handle SIGINT and SIGTERM
- close database and WebSocket resources cleanly
- report startup failures clearly
- prevent duplicate daemon instances with a local lock
- support local foreground operation for development

Provide reliable local commands such as:

```text
nuaai daemon
nuaai status
nuaai doctor
nuaai version
nuaai init
```

Do not enable a system service automatically. Prepare documented systemd/s6 integration only after the local daemon works, and require explicit approval before enabling a persistent host service.

## Durable Data Model

Use SQLite and Drizzle for durable state. Every schema change requires a migration or explicit versioned initialization path.

Persist at minimum:

- workspaces
- sessions
- threads
- messages
- agent runs
- run status
- model output chunks
- provider metadata
- model metadata
- tool calls
- tool results
- errors
- background tasks
- schedules
- schedule executions
- cancellation state
- plugins
- skills
- skill versions
- memory records
- embeddings
- encrypted secret references
- audit events
- timestamps

Do not store model credentials or provider secrets in plaintext.

## Versioned Event Contract

Every meaningful runtime action emits a normalized, versioned event.

Required event families include:

```text
session.created
session.resumed
session.closed
thread.created
message.created
run.created
run.started
run.paused
run.resumed
run.cancel_requested
run.cancelled
run.completed
run.failed
model.started
model.delta
model.completed
tool.started
tool.completed
tool.failed
memory.stored
memory.retrieved
task.queued
task.started
task.paused
task.resumed
task.completed
task.failed
schedule.created
schedule.updated
schedule.paused
schedule.triggered
plugin.loaded
plugin.unloaded
skill.loaded
skill.failed
provider.connected
provider.unavailable
```

Every event must include:

- event schema version
- event ID
- event type
- session/thread/run/task ID where applicable
- timestamp
- source
- redacted payload
- correlation ID

Persist events before reporting a successful state transition. Support event replay from a cursor for reconnecting TUI and web clients.

## Agent Runtime

Implement a real persistent Observe → Plan → Act loop:

1. Load session, thread, recent messages, active run, configuration, and permissions.
2. Observe workspace state and relevant scheduled/background state.
3. Retrieve relevant memories.
4. Construct a provider request.
5. Stream model output through normalized events.
6. Validate model tool calls with Zod.
7. Check permissions and approval requirements.
8. Execute secure tools.
9. Persist tool calls, results, errors, and events.
10. Feed tool results back into the active run.
11. Continue until completion, cancellation, timeout, or a bounded failure condition.
12. Persist final state and emit a terminal event.

Required controls:

- maximum turns
- maximum tool calls
- maximum output bytes
- per-run timeout
- provider timeout
- tool timeout
- cancellation
- retry policy
- retry limit
- loop detection
- duplicate tool-call protection
- backpressure
- clear unavailable/refusal/error states
- redacted logs
- no infinite loops

The runtime must support both interactive sessions and scheduled background agents through the same engine.

## Provider Integrations

### Ollama

Use the installed Ollama runtime as the primary local provider.

Before implementation:

- inspect `ollama --version`
- inspect `ollama list`
- inspect `ollama --help`
- verify the available models
- verify the supported chat, streaming, tool, and embedding behavior
- verify package compatibility

Implement:

- provider discovery
- model selection
- streaming text
- tool-call support where the selected model supports it
- cancellation
- timeout handling
- provider health
- unavailable-provider errors
- model capability reporting
- embedding generation
- configuration through `.nuaai/config.json` and environment variables

Run a real Ollama smoke test when Ollama and a usable model are available. If no model is available, report the exact command and blocker. Never fabricate model output.

### OpenAI Codex

Treat Codex as a separate provider boundary.

Before implementation:

- inspect the installed `codex` executable
- inspect `codex --help`
- inspect non-interactive execution modes
- inspect structured or JSONL output support
- inspect exit codes
- inspect cancellation behavior
- inspect working-directory and environment behavior

Implement a controlled Codex adapter with:

- `execa` or Node subprocess APIs
- shell disabled
- validated command arguments
- timeout handling
- cancellation
- stdout/stderr capture
- output caps
- structured event parsing where supported
- non-zero exit handling
- secret redaction
- provider metadata
- deterministic fake-executable tests
- real Codex smoke testing when available

Never guess Codex CLI flags. Use verified installed behavior.

Normalize Ollama and Codex into the same provider event contract without pretending that both APIs are identical.

## Scheduler and Background Agents

Scheduled background agents are required, not optional.

Implement a durable SQLite-backed scheduler without adding a queue dependency unless a demonstrated requirement makes a queue dependency necessary.

Required schedule types:

- one-shot
- interval
- cron-style schedule
- manual trigger
- startup trigger

Required scheduler behavior:

- persistent schedule definitions
- pause/resume
- enable/disable
- next-run calculation
- missed-run policy
- concurrency limits
- per-agent run limits
- retry policy
- backoff
- cancellation
- lock ownership
- duplicate-trigger prevention
- crash recovery
- daemon restart recovery
- run history
- failure history
- output and event persistence
- schedule editing through TUI and web UI
- schedule inspection through CLI

Background agents must use the same session, event, provider, memory, skill, tool, and permission systems as interactive agents.

A background agent must never silently run with broader permissions than an interactive agent.

## Encrypted Secrets

Encrypted secrets are required.

Use Node’s built-in `node:crypto` primitives unless a real platform requirement proves an external secret manager necessary.

Implement:

- AES-256-GCM encryption
- authenticated ciphertext
- unique nonce/IV per secret
- master-key configuration
- key rotation
- versioned ciphertext format
- secret deletion
- secret existence checks without plaintext exposure
- provider-specific secret names
- no plaintext secret values in SQLite
- no plaintext secret values in logs
- no secret values in TUI/web responses
- redaction in subprocess output
- clear missing-key and invalid-key errors
- restrictive local file permissions for secret material

The master key must come from a documented secure configuration path. Do not hardcode keys, salts, tokens, or passwords. Do not invent OS keychain support without verifying the host API.

Add tests for:

- encryption/decryption
- tampering
- wrong key
- key rotation
- deletion
- redaction
- persistence
- restart behavior

## Secure Tools and Workspace Operations

Implement a secure tool registry with Zod input and output schemas.

Initial real tools:

- list workspace files
- read workspace file
- write workspace file
- create patch
- inspect Git status
- inspect Git diff
- search workspace content
- run an explicitly allowlisted command
- inspect process/task status
- inspect memory
- inspect schedules

Every tool requires:

- name
- description
- input schema
- output schema
- capability declaration
- permission level
- timeout
- output cap
- audit event
- explicit error behavior

Enforce:

- workspace root boundaries
- traversal prevention
- symlink escape checks
- command allowlists
- shell disabled by default
- subprocess timeouts
- output caps
- redaction
- cancellation
- destructive-action classification
- approval state where required

Do not expose arbitrary shell execution through a generic model tool.

## Skills

Skills live under:

```text
.nuaai/skills/
```

Implement:

- skill discovery
- manifest schema
- name validation
- version validation
- compatibility checks
- Zod input/output schemas
- registration
- dispatch
- enable/disable state
- skill permissions
- load errors
- cache invalidation
- audit logging
- safe compilation
- generated skill validation
- skill reload without daemon corruption
- skill inspection through TUI and web UI

Use `ts-morph` for source generation and `esbuild` for compilation only where required.

Do not execute generated skill code without validation and a controlled runtime boundary.

Add at least one real built-in skill and at least one filesystem-loaded skill that exercise the complete load → validate → register → dispatch path.

## Plugins

Plugins are required and separate from skills.

Implement a plugin system with:

- plugin manifest
- plugin name and version
- NUAAI API compatibility range
- plugin capability declarations
- plugin lifecycle
- plugin load/unload
- plugin enable/disable
- plugin configuration
- plugin health
- plugin permissions
- plugin audit events
- plugin dependency validation
- plugin version compatibility checks
- plugin failure isolation
- plugin reload behavior
- plugin inspection through TUI and web UI

Use a trusted local plugin boundary first. Any plugin with subprocess or filesystem capability must declare that capability explicitly.

Untrusted or generated plugin code must not receive unrestricted in-process access. Use a process boundary or refuse loading until a safe boundary exists.

Do not add a plugin marketplace or remote installer unless explicitly requested. Local plugin discovery and lifecycle are required.

## Memory and Vector Retrieval

Implement complete memory behavior using SQLite, Drizzle, and sqlite-vec.

Required path:

```text
conversation/event
  → memory extraction
  → embedding generation
  → encrypted or privacy-safe persistence
  → sqlite-vec storage
  → semantic retrieval
  → session context injection
```

Required capabilities:

- store messages and events
- store explicit memories
- generate embeddings through Ollama when available
- store embeddings in sqlite-vec
- retrieve by similarity
- filter by session/thread/time/type
- avoid duplicate memory writes
- handle unavailable embedding providers honestly
- expose memory inspection
- support deletion
- support retention controls
- preserve deterministic fallback behavior when embeddings are unavailable

The sqlite-vec extension must load through the real installed API and be tested against a real database. Pure cosine math alone is not semantic memory retrieval.

## HTTP and WebSocket API

Implement authenticated local APIs for:

- health
- version
- provider status
- provider models
- session creation
- session listing
- session retrieval
- thread creation
- run creation
- run cancellation
- run resume
- task listing
- task cancellation
- schedule creation
- schedule update
- schedule pause/resume
- memory search
- skill listing
- plugin listing
- event replay

WebSocket requirements:

- HMAC authentication
- connection lifecycle events
- session subscription
- task subscription
- event replay from cursor
- live event streaming
- reconnect behavior
- disconnect handling
- bounded queues
- backpressure
- cancellation messages
- provider and daemon error events
- no secret leakage

Test HTTP and WebSocket behavior through real requests and real socket connections.

## Full Ink TUI

Build a full TUI client connected to the daemon.

Required surfaces:

- session list
- thread list
- conversation view
- streaming model output
- input composer
- provider/model selector
- active tool execution
- background task panel
- schedule panel
- run cancellation
- errors and retry state
- memory browser
- skills browser
- plugins browser
- command palette
- connection status
- daemon start/connect failure state
- session resume after restart
- provider health
- settings and secret-presence status without secret values

The TUI must not contain a second agent runtime. The daemon remains the source of truth.

Test meaningful TUI behavior through deterministic event/state tests.

## Full React Web UI

Build a real web dashboard connected to the daemon.

Required surfaces:

- session navigation
- thread navigation
- live conversation
- streaming output
- tool activity
- background task queue
- schedule management
- memory browser
- skill browser
- plugin browser
- provider health
- run history
- connection state
- empty states
- loading states
- error states
- cancellation controls
- secret-presence status without secret values
- responsive layout

No fake metrics, fake messages, placeholder conversations, or static dashboard data are allowed in production paths.

Use the same HTTP/WebSocket event contracts as the TUI.

## Mandatory Browser End-to-End Testing

Browser E2E is required and cannot be treated as optional.

Use Playwright or the already-installed browser test infrastructure. Add the dependency only if required by the project.

Browser E2E must run against the actual built web UI and a real local daemon.

Required browser journeys:

1. Start daemon.
2. Open web UI.
3. Verify connection status.
4. Create or select a session.
5. Start a deterministic local test run through the daemon.
6. Observe streamed events in the web UI.
7. Observe tool activity.
8. Cancel a run.
9. Resume or reload the session.
10. Verify persisted history.
11. Open memory view.
12. Open skills view.
13. Open plugins view.
14. Open schedules/background agents view.
15. Verify unavailable-provider and daemon-error states.
16. Verify no secrets appear in rendered UI.

Browser E2E must use real routes, real WebSocket connections, real server state, and real persistence. Static component snapshots are not enough.

Add browser coverage for responsive layouts and the primary empty/loading/error states.

## Quality and Testing Requirements

Use TDD for new behavior:

1. Write a focused failing test.
2. Run the test and verify the expected failure.
3. Implement the smallest correct behavior.
4. Run the focused test.
5. Run the complete affected suite.
6. Refactor only while tests remain green.

Required test layers:

- pure unit tests
- data model tests
- SQLite integration tests
- sqlite-vec integration tests
- migration tests
- provider contract tests for every provider adapter
- Ollama smoke test when Ollama is available
- Codex fake-executable subprocess tests
- Codex real smoke test when Codex is available
- daemon HTTP tests
- WebSocket tests
- session recovery tests
- scheduler tests
- background-agent tests
- cancellation tests
- timeout tests
- encryption tests
- key rotation tests
- redaction tests
- tool security tests
- plugin lifecycle tests
- skill loading and dispatch tests
- TUI event/state tests
- web UI tests
- mandatory Playwright browser E2E tests
- production-shaped end-to-end smoke test

Coverage requirements:

- minimum 80% global lines
- minimum 80% global functions
- minimum 80% global branches
- minimum 80% global statements
- minimum 80% per-file coverage across every measured source module
- every provider adapter must be measured
- every database/model/service module must be measured
- every scheduler/background-agent module must be measured
- every encryption/security module must be measured
- every plugin and skill module must be measured
- no hiding implementation files from coverage merely to pass
- exclude only true process entrypoints, generated artifacts, and browser-only bootstraps with documented reasons

Quality gate must produce:

- zero TypeScript errors
- zero Biome errors
- zero test failures
- zero skipped tests
- zero unhandled promise rejections
- zero project-script warnings
- passing coverage thresholds
- passing Node build
- passing web build
- passing browser E2E
- passing version check
- clean Git diff

## Dependency Discipline

No external dependency may remain unless required by a demonstrated product boundary.

For every dependency:

- identify the source module using it
- identify the requirement it satisfies
- verify package compatibility
- pin or lock the version appropriately
- test installation from a clean lockfile
- remove unused packages
- avoid duplicate libraries solving the same problem
- prefer Node built-ins for crypto, timers, process control, filesystem, URL handling, and IPC
- prefer SQLite-backed local behavior over adding Redis or a queue service without a real requirement
- prefer existing Vercel AI SDK/provider packages over duplicate model clients
- add Playwright only because mandatory browser E2E requires it

Run dependency validation and report unused, invalid, deprecated, or vulnerable packages. Do not suppress findings without a documented reason.

## Documentation Requirements

Keep documentation synchronized with the actual product.

Update:

- README
- architecture documentation
- runtime configuration reference
- Ollama setup
- Codex setup
- daemon usage
- TUI usage
- web UI usage
- workspace layout
- security model
- encrypted secrets guide
- scheduler/background-agent guide
- skill authoring guide
- plugin authoring guide
- memory behavior
- browser E2E instructions
- troubleshooting
- release/versioning instructions
- CHANGELOG

Never document an integration as complete until a real test or smoke run proves the integration.

## Versioning and Git Tags

Implement mechanical version checking:

- valid SemVer in `package.json`
- matching root `package-lock.json` version
- latest Git tag must equal `v<package.version>`
- release tag must point to the completed verified commit
- no dirty working tree after release preparation
- no secrets or private data staged
- commit author must be human

Run the complete gate before creating or moving a release tag.

## Execution Order

Before writing implementation code:

1. Inspect the repository and current state.
2. Inspect installed Ollama and Codex capabilities.
3. Inspect package versions and dependency graph.
4. Inspect current tests and build scripts.
5. Write a complete implementation plan in the repository.
6. Identify all required files and acceptance tests.
7. Identify genuine blockers and safe fallback paths.

Then execute in dependency order:

1. event contracts and runtime types
2. database schema and migrations
3. daemon lifecycle and recovery
4. session/thread/run persistence
5. Ollama provider
6. Codex provider
7. persistent Observe → Plan → Act runtime
8. encrypted secrets
9. secure tools
10. memory and embeddings
11. scheduler and background agents
12. skills
13. plugins
14. HTTP API
15. WebSocket event bus
16. full TUI
17. full web UI
18. mandatory browser E2E
19. documentation and dependency cleanup
20. complete verification

Do not stop between phases to ask whether to continue. Continue automatically unless a genuine architectural decision, credential, or external state change is required.

## Final Acceptance Criteria

NUAAI is not complete until all conditions below are verified:

- `nuaai daemon` starts successfully.
- `.nuaai/` initializes safely and idempotently.
- A session can be created.
- A session survives daemon restart.
- Threads and messages persist.
- Ollama executes a real streamed run when Ollama and a usable model are available.
- Codex executes through the verified CLI adapter when Codex is available.
- Provider unavailable states are truthful and tested.
- Agent output streams through the daemon.
- TUI displays the live run.
- Web UI displays the same live run.
- TUI and web UI reconnect to an existing session.
- At least one real secure workspace tool works.
- Tool calls and results persist.
- Memory persists.
- Embeddings and sqlite-vec retrieval work through the actual path.
- Scheduled background agents run and persist execution history.
- Scheduled agents survive daemon restart.
- Runs can be paused, resumed, cancelled, and retried according to policy.
- Secrets are encrypted at rest.
- Key rotation works.
- Secrets never appear in logs, events, database plaintext fields, or rendered UI.
- Skills load from `.nuaai/skills/`.
- Plugins load through manifests and capability checks.
- Plugin lifecycle failures do not corrupt the daemon.
- Generated skills/plugins are validated before execution.
- Browser E2E passes against the real daemon and built web UI.
- No fake production data exists.
- All source modules meet coverage requirements.
- All tests pass.
- Biome passes.
- TypeScript passes.
- Node build passes.
- Web build passes.
- Browser E2E passes.
- Dependency audit passes or every finding has a documented, verified reason.
- Version checking passes.
- Final Git tree is clean.

## Final Report Format

At completion, report only verified facts:

1. Implemented capabilities.
2. Exact files and modules changed.
3. Exact commands executed.
4. Exact test, coverage, lint, typecheck, build, and browser results.
5. Ollama availability and smoke-test result.
6. Codex availability and smoke-test result.
7. Scheduler/background-agent result.
8. Encryption result.
9. Plugin and skill result.
10. Browser E2E result.
11. Dependency audit result.
12. Remaining blockers, if any.
13. Current version and Git commit.
14. Whether NUAAI is locally live, externally deployed, or neither.

Do not call NUAAI complete based only on compilation. Completion requires the working daemon, real provider paths, persistent sessions, scheduled background agents, encrypted secrets, plugins, skills, full TUI, full web UI, mandatory browser E2E, and verified end-to-end behavior.
