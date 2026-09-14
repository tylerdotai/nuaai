# NUAAI Hermes-Replacement Master Goal

> **Execution mode:** phase-by-phase implementation. Read this document before changing code. Do not declare the goal complete until every release gate passes with real evidence.
>
> **Product:** NUAAI — not ur avg ai
>
> **Primary outcome:** Build a lightweight, local-first personal agent harness centered on Ollama and local models, with durable state, multimodal understanding, permissioned tools, truthful execution, and Matrix/PWA/CLI/SSH access.

## Master goal prompt

```text
Build NUAAI into a credible lightweight replacement for the current Hermes workflow.

The target is not a Matrix bot with a few integrations. The target is one daemon-owned personal agent runtime that uses Ollama and local models by default, preserves durable sessions and memory, executes permissioned tools for real, reports the active provider/model truthfully, supports multimodal inputs and outputs, and exposes the same runtime through Matrix/Element, the PWA, the CLI, the TUI, and SSH.

Complete every unfinished capability listed in this goal document. Work phase by phase in dependency order. Do not start a later phase while an earlier phase has failing tests, unverified boundaries, unresolved security failures, or misleading product claims.

Keep the daemon, runtime, provider registry, tool registry, permission system, and durable store authoritative. Clients must remain thin adapters. Use Ollama/local models as the default path. Keep hosted providers optional and explicit.

Implement real capability contracts, not placeholders:
- first-class memory operations;
- first-class schedules and background tasks;
- explicit provider/model discovery, switching, persistence, and truthful reporting;
- complete bounded multimodal handling for images, audio, video, and common documents;
- MCP server discovery and execution behind permissions;
- computer-use behind an explicit capability boundary;
- controlled external-agent dispatch through allowlisted subprocess contracts;
- safe workspace, command, web, search, browser, media, and scheduling tools;
- Matrix/PWA/CLI/SSH parity against the same daemon state.

Do not add unrestricted shell execution. Do not expose loopback services publicly. Do not weaken authentication or tailnet-only access. Do not commit secrets, private runtime state, personal paths, credentials, generated media, or environment-specific hardcoding.

Do not claim completion because a model produced future-tense prose, a provider stopped streaming, a file was written locally, or a unit test passed. Completion requires authoritative tool results, durable terminal state, real boundary verification, and an explicit acceptance result.

External actions remain gated: ask before pushing, publishing, sending messages, changing DNS/Tailscale exposure, modifying production data, spending money, inviting accounts, or performing destructive operations.

At the end of every phase:
1. run the focused behavioral tests;
2. run the complete local gate relevant to the changed surface;
3. inspect the diff and secret scan;
4. record implemented, interface-only, blocked, and unstarted items;
5. commit locally with a human-authored message;
6. stop before external publication unless separately approved.

The goal is complete only when the final release gate in this document passes.
```

## 1. Product boundary

NUAAI is a single local-first runtime with multiple clients:

```text
Element/Matrix ─┐
PWA ────────────┼─ authenticated ── NUAAI daemon ── runtime/provider/tool boundaries
CLI ────────────┤                                      │
TUI ────────────┘                                      ├─ Ollama/local models
SSH ──────────── authenticated host access             ├─ SQLite durable state
                                                       ├─ permissioned tools
                                                       ├─ multimodal media pipeline
                                                       ├─ scheduler/task runner
                                                       └─ optional integrations
```

The daemon owns:

- sessions, threads, messages, and active-session bindings;
- runs, tool calls, failures, recovery, cancellation, and terminal status;
- provider/model selection and health;
- memory storage and retrieval;
- schedules and background tasks;
- permissions and capability grants;
- MCP/computer-use/external-agent boundaries;
- Matrix delivery and media attachments;
- audit events and redacted observability.

Clients must not maintain fake agent state or call providers directly.

## 2. Non-negotiable constraints

- Default provider: local Ollama; verify the configured model rather than assuming a model exists.
- Strict ESM TypeScript and Node.js conventions already present in the repository.
- `.nuaai/` remains ignored private runtime state.
- Services bind to loopback by default.
- Remote access remains authenticated and tailnet-only through Tailscale.
- Matrix encrypted rooms remain unsupported unless a real E2EE client boundary is implemented and tested.
- Element Classic is the current ordinary Synapse client target; Element X requires a separate Matrix Authentication Service decision.
- Workspace commands remain explicitly allowlisted, bounded, and `shell: false`.
- No inline Python/Node execution through workspace commands.
- No silent catches, fabricated provider output, invented tool results, or success after tool failure.
- New dependencies require a dependency audit and explicit approval before installation.
- External mutation requires approval even when the local implementation is ready.
- Tests must be deterministic except for separately labelled live-service/manual checks.
- Coverage thresholds must not be lowered, falsified, or bypassed.
- Public files must contain no credentials, personal paths, private hostnames, tokens, or environment-specific hardcoding.

## 3. Incomplete capability inventory

The following items are intentionally unfinished at the start of this goal. Re-audit the repository before implementation; this list is a starting contract, not permission to trust stale status claims.

### 3.1 Agent capability surface

- Hermes-level capability inventory and parity matrix.
- First-class model-facing memory tools.
- First-class model-facing schedule/task tools.
- Explicit provider/model discovery and switching.
- MCP discovery, health, permissions, and execution verification.
- Computer-use capability boundary and verification.
- External-agent dispatch through a safe subprocess contract.
- Complete media/document inspection tools.
- Consistent tool schemas and permission filtering across every client.

### 3.2 Multimodal behavior

- Native image input exists and must remain regression-tested.
- Audio currently depends on local transcription; the provider-neutral media contract is incomplete.
- Video audio transcription exists; bounded frame extraction and frame reasoning remain incomplete.
- PDF, DOCX, XLSX, image, audio, and video inspection remain incomplete as a unified tool surface.
- Multimodal history must retain safe metadata and derived text without persisting raw private bytes in ordinary conversation rows.
- Provider capability reporting must distinguish native modality support from local preprocessing.

### 3.3 Provider/model behavior

- `/model` or equivalent explicit command/API.
- Provider/model list and health surface.
- Availability validation before switching.
- Durable selected-provider/model persistence.
- Run-level provider/model override where permitted.
- Truthful reporting after pull, switch, failure, restart, and fallback.
- No confusion between downloading a model and selecting it as active.

### 3.4 Client and operational verification

- Element iOS voice round trip.
- PWA run and cancellation against the real daemon.
- CLI and SSH workflows against the same durable state.
- Authenticated MCP status verification.
- Restart persistence and active-session binding verification.
- Full release gate and public publication approval.

## 4. Definition of done

The master goal is complete only when all conditions below are true:

1. Every required capability has a written contract, owner module, permission rule, failure state, and behavioral test.
2. Every advertised agent tool is model-callable through the daemon and returns authoritative structured results.
3. Every failed tool call produces a failed/recovering terminal state or an explicit abandoned state; final prose cannot override tool failure.
4. Provider/model selection is explicit, durable, validated, and visible in status, runs, Matrix, PWA, CLI, and TUI.
5. Images, audio, video, and supported documents have bounded ingestion, safe derived representations, and real processing verification.
6. Memory and schedules are available as model-facing capabilities, not only as UI/database features.
7. MCP, computer-use, and external-agent capabilities are either implemented and verified or explicitly classified as blocked/non-goal with the reason recorded.
8. Matrix, PWA, CLI, TUI, and SSH exercise the same daemon-owned state and permission boundary.
9. Real local-service checks pass for Ollama, search, extraction, browser automation, Matrix, and media where enabled.
10. Physical phone validation passes for Element and PWA while Tailscale is connected.
11. Public repository files pass privacy/leak review and contain no environment-specific runtime state.
12. Local lint, typecheck, tests, strict coverage, production build, web build, browser E2E, dependency audit, and diff checks pass after the final source edit.
13. External publication remains a separate approved action; local completion and public release are reported separately.

## 5. Phase plan

### Phase 0 — Baseline, capability matrix, and acceptance contract

**Objective:** Establish the authoritative gap list before adding code.

**Work:**

- Inspect `AGENTS.md`, `README.md`, architecture/config/security docs, package scripts, source tree, tests, current Git state, and current daemon state.
- Inventory every current tool, endpoint, provider, client action, scheduler action, memory operation, MCP boundary, and media boundary.
- Inspect Hermes documentation/configuration only as a capability reference; do not copy private or product-specific behavior.
- Create a capability matrix with columns: capability, NUAAI surface, permission, provider dependency, persistence, failure state, deterministic test, live/manual test, status.
- Classify each Hermes capability as `implemented`, `rework`, `blocked`, `explicit non-goal`, or `unstarted`.
- Define the public NUAAI contract and remove stale README claims that imply parity before parity exists.

**Gate:** The matrix covers every requested capability and every remaining gap has an acceptance test or an explicit blocker/non-goal. No implementation starts until the matrix is internally consistent.

### Phase 1 — Runtime contracts and permissioned tool registry

**Objective:** Make every core capability model-callable through one typed, permission-filtered registry.

**Required tools:**

```text
workspace.list
workspace.read
workspace.inspect
workspace.write
workspace.search
workspace.command
web.search
web.fetch
browser.open
memory.search
memory.store
memory.forget
schedule.create
schedule.list
schedule.update
schedule.pause
schedule.resume
schedule.trigger
schedule.cancel
provider.list
provider.status
provider.switch
media.inspect
media.transcribe
media.extract_frames
media.synthesize
mcp.list
mcp.status
mcp.call
computer.use
agent.dispatch
```

The exact final set may change after the Phase 0 parity matrix, but every advertised tool must have:

- provider-neutral schema;
- Zod/runtime validation;
- read/write/execute permission classification;
- capability and network checks;
- bounded input/output;
- durable event records;
- explicit error results;
- focused behavioral tests;
- client-visible status where relevant.

Do not expose `computer.use`, `mcp.call`, or `agent.dispatch` by default. They require explicit configuration and permission grants.

**Gate:** A deterministic provider can call each enabled tool through the full runtime loop, receive a structured result, persist events, and recover from a structured failure. Permission filtering prevents unavailable tools from being advertised.

### Phase 2 — Durable memory and scheduling as agent capabilities

**Objective:** Promote existing storage/runtime features into reliable model-facing operations.

**Memory:**

- Add explicit search/store/forget tools.
- Preserve provenance, timestamps, source, confidence, and supersession behavior.
- Treat retrieved memory as untrusted context, never as an authority or capability list.
- Prevent secrets and protected runtime state from entering ordinary memory.
- Add retention/export/delete behavior appropriate for local private state.

**Scheduling:**

- Expose create/list/update/pause/resume/trigger/cancel tools.
- Persist schedule policy, retry count, concurrency limit, missed-run behavior, and task identity.
- Propagate task cancellation to the active run/provider.
- Recover interrupted tasks after restart with an explicit recovered failure state.
- Return durable task IDs and terminal statuses to every client.

**Gate:** A model can create a schedule, trigger it, observe the task/run relationship, cancel it, restart the daemon, and inspect the durable result without relying on UI-only routes.

### Phase 3 — Provider/model selection and truthful reporting

**Objective:** Make provider/model choice real and durable.

**Work:**

- Add provider/model list, health, and capability reporting.
- Add authenticated API and client commands for listing and switching.
- Add Matrix command support for status and switching, with explicit validation.
- Persist selected provider/model in ignored runtime configuration or durable settings without overwriting secrets.
- Support run-level overrides only when permission and provider policy allow them.
- Verify model availability through the real provider boundary before activation.
- Distinguish `pull`, `available`, `selected`, `loading`, `failed`, and `active` states.
- Record provider/model on every run and message.
- Make restart behavior deterministic and visible.

**Gate:** A live model switch changes the next run, status reports the actual active selection, unavailable models fail explicitly, and a model download never claims that the active selection changed unless a switch was performed.

### Phase 4 — Unified multimodal and document pipeline

**Objective:** Give NUAAI a complete bounded media contract instead of separate attachment special cases.

**Provider contract:**

Define a discriminated provider-neutral content model for:

```text
text
image
audio
video
document
```

Each part must include safe metadata, bounded bytes or derived artifact references, source provenance, and a lifecycle rule. Raw private bytes must not be inserted into ordinary message history.

**Images:**

- Preserve native Ollama image serialization.
- Validate MIME type, byte limit, dimensions, and decodeability.
- Test malformed, oversized, and valid images.

**Audio:**

- Keep the existing Faster-Whisper bridge behind the bounded subprocess boundary.
- Expose transcription as a first-class media operation.
- Return language, segments, confidence/availability metadata where supported, and explicit no-speech/error states.
- Keep TTS as a separate output operation.

**Video:**

- Extract audio through a bounded local process.
- Extract a bounded number of frames at deterministic timestamps.
- Enforce total size, duration, frame count, pixel count, and process timeout limits.
- Pass derived transcript and frame content through the provider-neutral contract.
- Verify no raw video dump enters the prompt or durable message history.

**Documents:**

- Add bounded inspection for PDF, DOCX, XLSX, and ordinary text/image formats.
- Return metadata, extracted text, tables/sheets where supported, and explicit unsupported/encrypted/corrupt states.
- Protect temporary artifacts and prevent path traversal.
- Add fixtures that contain no private data.

**Gate:** Each supported modality passes deterministic fixture tests and one real local runtime probe. Unsupported or unavailable processing produces a truthful failure and never a fabricated summary.

### Phase 5 — MCP, computer-use, and external-agent boundaries

**Objective:** Add advanced capabilities without turning NUAAI into unrestricted host control.

**MCP:**

- Validate configured server definitions.
- Start only explicitly enabled servers.
- Record process identity, health, schemas, failures, and shutdown state.
- Namespace tools as `mcp.<server>.<tool>`.
- Filter by permission and network capability.
- Add authenticated status and execution verification.
- Do not leave diagnostic MCP processes running.

**Computer use:**

- Define a narrow capability contract for screenshots, pointer, keyboard, and browser/native targets.
- Require explicit permission and foreground/background policy.
- Refuse password, secret, payment, and permission-dialog interactions.
- Verify actions through fresh state captures; never claim a click succeeded from dispatch alone.
- Add a safe deterministic test target before any live desktop test.

**External agents:**

- Define an allowlisted subprocess adapter for Codex/OpenCode/other approved agents.
- Use bounded stdin/stdout/stderr, timeout, cancellation, working-directory protection, and redaction.
- Return structured run IDs, status, output, and failures.
- Prevent an external agent from bypassing NUAAI permissions or writing outside the approved workspace.
- Require explicit approval before external network/state mutations.

**Gate:** Each boundary has a real subprocess or desktop verification, explicit permissions, clean shutdown, and an honest unavailable state when not configured.

### Phase 6 — Client parity and real phone workflows

**Objective:** Make every client a reliable view/control surface over the same daemon.

**Matrix/Element:**

- Add `/model` and any approved capability commands to the explicit parser/help surface.
- Preserve immediate acknowledgement, typing, throttled progress, and final response behavior.
- Validate text, image, audio, video, document, failure, cancellation, and TTS messages.
- Verify unencrypted Element Classic room behavior through the real tailnet endpoint.

**PWA:**

- Exercise sessions, messages, tool progress, cancellation, memory, schedules, provider/model switching, media input/output, and error states against the authenticated daemon.
- Ensure no fake client-side state survives a reload.
- Verify mobile layout and PWA install shell over Tailscale.

**CLI/TUI/SSH:**

- Add commands for status, run, model/provider, goals/plans if needed, schedules, memory, and diagnostics.
- Verify CLI and TUI mutations call daemon routes rather than local-only state.
- Verify SSH access reaches the same host/runtime without exposing a public daemon bind.

**Gate:** A manual iPhone test completes one text run, one voice run, one image run, one model-status/switch action, and one schedule or memory action. PWA, CLI, and SSH can observe the same resulting durable state.

### Phase 7 — Release hardening and publication readiness

**Objective:** Prove the product is complete locally before any public mutation.

**Work:**

- Remove stale roadmap claims and update architecture/security/configuration docs.
- Run repository privacy/leak scan for credentials, personal paths, private hostnames, runtime state, and environment-specific values.
- Run dependency audit and review all advisories.
- Run the complete gate after the final source edit:

```bash
npm run check
npm test
npm run test:coverage
npm run build
npm run build:web
npm run test:e2e
npm audit --audit-level=low
npm run version:check
git diff --check
git status --short --branch
```

- Verify no diagnostic daemon, MCP process, container, browser, or test process remains unintentionally.
- Record the final capability matrix with evidence for every row.
- Prepare a release commit locally.
- Stop before `git push`, public release, deployment, or external account mutation until explicit approval.

**Gate:** Every required capability is either verified complete or explicitly documented as an approved non-goal/blocker. No “mostly complete” status is acceptable.

## 6. Test and evidence contract

Every implementation task must use this loop:

1. Write a failing behavioral test.
2. Run the focused test and retain the failure.
3. Implement the smallest production change.
4. Run the focused test.
5. Run adjacent integration tests.
6. Run the complete gate after cross-cutting changes.
7. Inspect durable state and external boundary output.
8. Update the capability matrix.

Evidence categories:

- `unit`: pure contract behavior;
- `integration`: daemon/provider/tool boundary;
- `live-local`: Ollama, Docker service, or local model execution;
- `manual-phone`: Element/PWA/SSH physical-client validation;
- `external-approved`: publication or remote mutation performed after approval.

A unit test cannot substitute for live-local or manual-phone evidence. A live-local test cannot substitute for external publication evidence.

## 7. Failure and stop conditions

Stop and report instead of guessing when:

- a provider, model, dependency, or external service is unavailable;
- a tool returns an error or malformed output;
- a capability requires a new dependency without approval;
- a task would expose a secret or protected runtime path;
- a command would mutate external state;
- a destructive operation is required;
- Matrix encryption or Element X support requires an unplanned protocol boundary;
- an acceptance test conflicts with the existing security contract;
- a public README claim cannot be backed by executable evidence.

Never replace a blocked implementation with a fake adapter, static sample output, or a success message.

## 8. Final report format

At completion, report:

```text
NUAAI Hermes-Replacement Goal: COMPLETE / INCOMPLETE

Verified complete:
- capability — evidence command/test/manual check

Interface-only:
- capability — missing runtime proof

Blocked:
- capability — exact blocker and required decision

Unstarted:
- capability — why it remains unstarted

Local release:
- commit:
- branch/status:
- daemon/process state:
- complete gate:

External state:
- pushed: yes/no
- deployed: yes/no
- phone validation: passed/not passed
```

Do not use “complete” when any required capability is interface-only, unverified, blocked without an approved non-goal, or still unstarted.
