# NUAAI capability matrix

This document is the v1 acceptance contract. A capability is not complete because an API, UI control, or prompt mentions it; completion requires daemon-owned behavior, a behavioral test, and a live boundary check where applicable.

Status values: `implemented` means the named contract has current proof; `partial` means a usable slice exists but a named boundary remains; `planned` means no verified implementation exists; `blocked` means operator or external approval is required.

| Capability | Current status | Completion contract | Current proof / gap |
|---|---|---|---|
| Local-model runtime | implemented for chat | One daemon owns provider calls, tools, sessions, permissions, and run completion through native Ollama or OpenAI-compatible `/v1`. | Adapter tests, live model catalog, daemon health, and exact NUAAI → llama.cpp → Nemotron completion pass. |
| Durable sessions and events | implemented | SQLite persists sessions, threads, messages, runs, events, recovery state, and exceptional failure context; models can inspect bounded outcomes only for the current thread. | Persistence, failure-continuity, `run.history`, queue, interruption, and replay tests pass. |
| Truthful execution | implemented | Tool failures cannot become successful completion; cancellation, timeout, schedule outcome, recovery, and tool-budget finalization are explicit. | Runtime failure/cancellation/budget/scheduler tests pass. |
| Matrix text/commands | implemented | Allowlisted Matrix users can reach daemon-owned sessions and commands through the bot. | Live generated-operator login, private room invite/join, `/status` response, room cleanup, and disposable-device cleanup pass. |
| Matrix media/voice | partial | Image/audio/video/file staging, transcription, TTS, and outbound media remain bounded and optional. | Contract/fixture tests pass; a live phone media loop was not run for this release. |
| Synapse deployment | implemented | Pinned local homeserver retains state and exposes Matrix only through loopback/Tailscale. | Synapse v1.160.0, retained schema migration, local health, and tailnet version endpoint pass. |
| Tailscale-only access | implemented | Synapse maps to `/`; NUAAI maps to `/nuaai`; no Funnel/public bind. | Existing Serve routes return HTTP 200; live tailnet browser shell fits 390×844 with no error surface. |
| React PWA | implemented | Browser client uses daemon APIs and Server-Sent Events state without owning truth; tool lifecycle rows pair by call ID and terminal failures display bounded causes. | Production-bundle desktop/mobile E2E, legacy event projection, and visual QA pass. |
| CLI and TUI | implemented | CLI/TUI use authenticated daemon state and expose actionable failure behavior. | CLI subprocess, TUI state, command, schedule, provider, and cancellation tests pass. |
| Local search chain | implemented | `web.search` uses local SearXNG with DuckDuckGo fallback; model-facing `web.fetch` is exposed only when browser automation is enabled and uses guarded Playwright rather than unconstrained crawler sidecars. | Feature-gating, URL-policy, launch-fallback, and live system-Chrome tests pass. |
| Browser automation | partial | Browser tools remain permissioned, timed out, restricted to public HTTP(S) destinations and safe ports, and fail closed on service workers, WebSockets, redirects, and protocol upgrades; each direct request is revalidated. Browser DNS is not IP-pinned. | Literal/DNS/private-subresource unit tests and real-Chromium redirect/WebSocket confinement tests pass; broad site compatibility and network-sandbox isolation are not claimed. |
| Memory store/search/forget | implemented with lexical fallback | Explicit memory operations persist real records; automatic and manual recall use semantic search when available and bounded lexical ranking otherwise. | Store/search/forget plus automatic fallback tests pass. Both current llama.cpp servers return 501 for embeddings, so this deployment truthfully reports and uses lexical mode. |
| Schedules/background tasks | implemented | Create/list/update/pause/resume/trigger/cancel share the scheduler and preserve true run outcomes. | Runtime, registry, retry, concurrency, and browser automation tests pass. |
| Provider/model discovery | implemented | Providers expose configured identity, health, catalog, and active state; switch persists before reporting success. | Local `/v1/models`, authenticated provider API, switch tests, and active readback pass. |
| Codex Responses | implemented | ChatGPT OAuth remains Codex-owned; streaming text and structured tool calls use the fixed Codex backend while actions execute through NUAAI permissions and tools. | Direct endpoint probe, authenticated production API turn, live `workspace.list`, live `workspace.write` → `workspace.read`, structured SSE, auth-refresh subprocess, catalog, timeout, and redaction contracts pass. |
| Image understanding | implemented in adapter contracts | Bounded images reach vision-capable providers as structured content. | Native Ollama and OpenAI-compatible serialization tests pass. |
| Audio understanding/TTS | partial | Faster-Whisper and Kokoro remain optional daemon-controlled integrations. | Local component tests/fixtures pass; live Matrix voice/TTS loop remains unverified. |
| Video understanding | partial | Local audio/frame extraction produces bounded provider inputs. | Fixture extraction and failure tests pass; live model reasoning remains unverified. |
| PDF/DOCX/XLSX understanding | partial | Format-aware inspection returns bounded text/metadata. | Fixture and failure-path tests pass; live model document reasoning remains unverified. |
| MCP | partial | Configured MCP servers use bounded, permission-filtered managed subprocesses. | Fixture protocol/error/timeout tests pass; no external MCP server was selected for live interoperability. |
| Computer use | blocked | Computer use remains opt-in and routed through an allowlisted driver. | Disabled/permission tests pass; no live driver was authorized. |
| External-agent dispatch | partial | Only allowlisted agent binaries/arguments run in bounded subprocesses. | Allowlist/output/timeout/failure tests pass; no live external agent was selected. |
| Workspace/tool contracts | implemented | Registered tools validate input, permission, path, timeout, and output bounds. | Registry, traversal, symlink, hard-link, command, and failure tests pass. |
| Security/PII hygiene | implemented for release artifacts | Tracked source/docs and package tarball contain no credentials, private runtime state, or generated data. | Secret-pattern scan, package allowlist, private file modes, and ignored runtime state pass. |
| Public repository | release-gated | The v1 branch, tag, GitHub Release, and attached package must resolve to the same verified commit. | PR checks, tag checks, Release metadata, and installed-artifact smoke are mandatory publication evidence. |

## Release gate

NUAAI v1 may ship with optional capabilities marked `partial` or `blocked` only when the limitation is explicit and the core chat/runtime/web/Matrix/Tailscale path remains truthful. External publication, boot-time service enablement, and any host security-policy change remain operator gates.
