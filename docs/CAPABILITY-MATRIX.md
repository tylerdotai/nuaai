# NUAAI capability matrix

This document is the acceptance contract for the Hermes-replacement build. A capability is not complete because an API, UI control, or model prompt mentions it; completion requires a daemon-owned implementation plus a behavioral test and, where applicable, a live-service check.

Status values: `implemented` means the current code and tests cover the contract; `partial` means a usable slice exists but a required boundary is missing; `planned` means no verified implementation exists yet; `blocked` means human or external approval is required.

| Capability | Current status | Completion contract | Required proof |
|---|---|---|---|
| Ollama-first runtime | implemented | One daemon owns provider calls, tools, sessions, permissions, and run completion. | Runtime integration tests; daemon health; full gate. |
| Durable sessions and events | implemented | SQLite persists sessions, threads, messages, runs, events, and recovery state. | Persistence/restart tests. |
| Truthful execution | implemented | Tool failures cannot become successful run completion; cancellation and recovery are explicit. | Runtime failure/cancellation tests. |
| Matrix / Element transport | partial | Authenticated Matrix sync, receipts, typing/progress, text, image, audio, and session commands work through the daemon. | Synapse `/versions` probe passes; live authenticated bot/Element Classic text/image/audio loop is not configured/physically validated. |
| Tailscale-only access | partial | Loopback services are exposed only through authenticated Tailscale Serve; no Funnel/public bind. | `tailscale serve status`, tailnet PWA/Matrix probes, and 401 auth probe pass; phone test remains manual. |
| PWA / CLI / TUI / SSH clients | partial | Clients call daemon APIs and never maintain authoritative state locally. | PWA E2E passes; CLI `status`/`doctor` and TUI state tests pass; SSH port is open, but same-state SSH/physical-client workflow is not manually validated. |
| Local search chain | implemented | `web.search` uses local SearXNG, then DuckDuckGo fallback; `web.fetch` uses Crawl4AI, Playwright, and FlareSolverr fallback. | Integration tests and live local endpoint probes. |
| Browser automation | partial | Playwright and FlareSolverr are permissioned network tools with bounded URLs, timeouts, cleanup, and truthful failures. | Browser integration tests plus live fetch. |
| Memory store/search/forget | implemented | Model-facing tools explicitly store, search, and forget durable records; embeddings are optional and failures are visible. | Tool behavior tests, lexical fallback, deletion, and live durable-memory endpoint. |
| Schedules/background tasks | implemented | Model-facing create/list/update/pause/resume/trigger/cancel APIs share the scheduler and task state. | 38 runtime tests, registry contract tests, and live schedule/task endpoint readback. |
| Provider/model discovery | implemented | Providers report configured identity, health, model catalog, and active state; model switch validates and persists before reporting success. | Registry tests, live Ollama catalog, authenticated switch/readback, and invalid-model 400 probe. |
| Image understanding | implemented | Bounded Matrix/workspace images reach vision-capable providers as structured content. | Ollama serialization and runtime image tests. |
| Audio understanding/TTS | partial | Bounded local Faster-Whisper transcription and Kokoro TTS remain optional and daemon-controlled. | Real local Whisper transcription and Kokoro WAV synthesis pass; Matrix voice/TTS loop remains manual. |
| Video understanding | partial | Audio is extracted locally; bounded frames are extracted and sent as structured image content with metadata. | Real fixture MP4 extraction and failure tests pass; full model-request reasoning remains unverified. |
| PDF/DOCX/XLSX understanding | partial | Inspect tools return bounded, non-secret text/metadata using format-aware parsers, with size/time limits. | DOCX/XLSX fixtures, PDF failure-path test, and media contract tests pass; live model-facing document reasoning remains unverified. |
| MCP | partial | Authenticated/permissioned discovery, status, and execution use bounded managed subprocesses and truthful errors. | Fixture MCP server, malformed output, timeout, permission, computer mapping, and API/tool tests pass; no configured external MCP server is available for interoperability validation. |
| Computer-use | partial | Computer-use is opt-in, permissioned, bounded, and routed through an allowlisted MCP/driver boundary. | Disabled/permission/security tests pass; live validation is blocked because `cua-driver` is not running. |
| External-agent dispatch | partial | Only explicitly allowlisted agent binaries/arguments can run in bounded workspace subprocesses; output, timeout, and failure are returned as task state. | Allowlist/bounded-execution tests pass; no configured external-agent adapter is enabled for a live probe. |
| Workspace/tool contracts | implemented | Every registered tool validates input, checks permission/capability, bounds output, and returns authoritative results. | Registry schema and failure tests. |
| Security/PII hygiene | partial | Tracked source/docs contain no credentials, personal absolute paths, private hostnames, or generated runtime state. | Tracked-file secret/path scan and audit. |
| Public repository | partial | Public repository contains verified local commits, sanitized docs, detailed README, and reproducible local setup. | `gh repo view`, clean diff, explicit push approval, post-push readback. |

## Release gate

NUAAI is not complete until every row is `implemented` or has an explicit, user-approved non-goal. External publication, physical phone actions, and any credential/permission prompt remain human gates even when local code is ready.
