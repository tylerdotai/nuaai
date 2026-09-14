<a id="readme-top"></a>

<div align="center">
  <h1>NUAAI</h1>
  <p><strong>not ur avg ai</strong></p>
  <p>A local-first AI agent harness with durable runtime state, a terminal UI, a web dashboard, Matrix phone access, local search, and controlled browser tools.</p>
  <p>
    <a href="https://github.com/tylerdotai/nuaai/issues">Report a bug</a>
    ·
    <a href="https://github.com/tylerdotai/nuaai/issues">Request a feature</a>
    ·
    <a href="https://github.com/tylerdotai/nuaai#roadmap">Roadmap</a>
  </p>
</div>

[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Local first](https://img.shields.io/badge/runtime-local--first-6f42c1?style=for-the-badge)](#privacy-and-telemetry)

## Table of contents

- [About the project](#about-the-project)
- [What ships](#what-ships)
- [Getting started](#getting-started)
- [Onboarding](#onboarding)
- [Usage](#usage)
- [Phone access](#phone-access)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Privacy and telemetry](#privacy-and-telemetry)
- [Security boundaries](#security-boundaries)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

## About the project

NUAAI is a persistent local agent runtime for people who want an agent to have durable memory, tools, schedules, and multiple interfaces without handing the whole control plane to a hosted SaaS product.

The daemon owns sessions, threads, runs, events, tools, memory, secrets, schedules, and recovery. The Ink TUI, React web client, CLI, and Matrix bridge are clients of that daemon. There is one runtime, one permission boundary, and one durable store.

The default path is a local model endpoint: native Ollama or an OpenAI-compatible `/v1` server such as llama.cpp. Optional integrations are explicit: Codex uses ChatGPT OAuth from the installed Codex CLI with the direct Codex Responses API, search starts with local SearXNG, arbitrary model-facing page extraction uses guarded Playwright, and phone messaging uses a local Synapse homeserver reachable through authenticated Tailscale Serve. Crawl4AI and FlareSolverr clients remain available only for explicitly trusted operator workflows; they are not automatic fallbacks for untrusted model-supplied URLs.

## What ships

- Durable SQLite runtime with sessions, threads, messages, runs, events, memories, tasks, schedules, skills, plugins, and vector rows.
- Observe → plan → act runtime loop with streaming, cancellation, timeouts, bounded output, and explicit manual resume after an interrupted daemon run.
- Dual local-provider adapter: native Ollama chat/embedding APIs or OpenAI-compatible `/v1` chat, tools, embeddings, and model discovery.
- Optional Codex Responses provider using the installed Codex CLI's ChatGPT OAuth state. Turns stream from the fixed Codex backend; tool calls execute through NUAAI's permission-filtered runtime and return as verified observations.
- Matrix bridge with invite auto-join, outbound replies, and a required static user or room allowlist.
- Matrix source-bound sessions with `/help`, `/status`, `/sessions`, `/new [title]`, `/switch <session-id>`, `/voice on|off|status`, and `/tts on|off|status` commands.
- Matrix file, image, audio, video, and sticker ingestion with bounded private staging and `MEDIA:` file delivery.
- Optional local voice input/output: Matrix audio and video attachments can use Faster-Whisper transcription, and completed responses can return Kokoro WAV audio. Text remains primary; voice input and TTS are independently disabled by default and require explicit runtime commands.
- Local web search through SearXNG with DuckDuckGo fallback.
- Model-facing page extraction through headless Playwright with public-address resolution, safe-port enforcement, credential rejection, service workers and WebSockets disabled, redirects blocked, and validation before every direct HTTP request.
- AES-256-GCM encrypted secret-manager values and redacted event/tool artifacts. Conversation, run, and memory content remains durable operator data and is stored verbatim.
- Automatic recall uses semantic retrieval when embeddings are available and bounded lexical retrieval otherwise; exceptional run failures are persisted into thread context for truthful follow-up diagnosis.
- Workspace traversal, symlink, and hard-link protection; command allowlists; subprocess timeouts; and daemon authentication.
- Bounded workspace file inspection for metadata and text previews; configured MCP servers are namespaced and permission-filtered.
- Ink TUI, React web dashboard, CLI commands, and authenticated HTTP/WebSocket APIs.
- Installable private NUAAI PWA with a viewport-bound responsive shell, durable conversations, run activity, memory, automations, system health, reconnect handling, and an authenticated command palette.
- Interactive onboarding with provider, integration, telemetry, Tailscale, and launch choices.

### Production agent contract

Authenticated operator clients run the complete perception → decision → action → observation loop. The provider receives one stable permission-filtered tool catalog, tool calls execute through typed daemon-owned handlers, results return to the provider as observations, and only the final answer becomes authoritative. Operator mode includes bounded workspace and durable database writes; `read-only` remains an explicit configuration profile for deployments that need it.

## Getting started

### Prerequisites

- Node.js 22 or newer.
- npm.
- Ollama or an OpenAI-compatible local endpoint for the default local provider.
- FFmpeg and ffprobe for audio/video inspection; zip and unzip for DOCX/XLSX inspection.
- Docker Engine and Docker Compose for any selected Matrix, local-search, or browser-fallback services.
- Tailscale for phone access from outside the host's local network.
- Codex CLI logged in with ChatGPT (`codex login status`) only if the Codex provider is enabled. NUAAI delegates near-expiry credential refresh to Codex's account RPC and never copies OAuth tokens into project configuration or the runtime database.

### Install from a checkout

```bash
git clone https://github.com/tylerdotai/nuaai.git
cd nuaai
npm ci
npm run build:release
npm link
```

`npm link` installs the checkout's executable wrapper into the local npm bin directory, making `nuaai tui`, `nuaai status`, `nuaai run <input>`, and `nuaai service ...` available from SSH shells. The direct checkout equivalent is `node scripts/nuaai.mjs tui`.

### One-line GitHub onboarding

This command pulls the repository, installs the package, and opens the interactive onboarding flow:

```bash
npx --yes github:tylerdotai/nuaai onboard
```

The onboarding flow asks which providers and integrations to enable, keeps telemetry disabled, starts only the selected local services, optionally exposes Synapse at the tailnet root and NUAAI at `/nuaai` through Tailscale Serve, and offers `tui`, `web`, or `skip` as the final launch choice. Browser setup installs the matching Playwright Chromium runtime; Matrix setup leaves public Synapse registration disabled after provisioning the operator and bot accounts.

### Install a release artifact

Download `nuaai-1.0.0.tgz` from the GitHub Release, then install and onboard it:

```bash
npm install --global ./nuaai-1.0.0.tgz
nuaai onboard
```

The release gate installs this exact tarball into a blank directory, starts the installed daemon, pairs a browser session, verifies all first-party skills, and checks authenticated API access.

For a non-interactive local configuration using the current defaults:

```bash
npx --yes github:tylerdotai/nuaai onboard --non-interactive
```

### Manual initialization

```bash
node dist/cli.js init
node dist/cli.js daemon
```

The daemon binds to a generated high loopback port. Read the assigned port from `.nuaai/config.json`; runtime state is ignored by Git.

### NUAAI PWA

The React client is served by the authenticated daemon and can be installed to an iPhone Home Screen from a tailnet-reachable browser. Run `nuaai pair [base-url]` on the host and open the resulting URL within five minutes. The short-lived pairing token stays in the URL fragment, is exchanged for a separate 30-day HTTP-only same-site cookie scoped to the app mount, and is removed from browser history before the dashboard loads. Then use the browser share menu and choose **Add to Home Screen**.

The **Commands** palette is NUAAI-native, not Element-native. It is available from the desktop or mobile header, or `⌘K` / `Ctrl+K`. Commands call the daemon directly:

- **New conversation** creates and activates a durable session.
- **New thread** creates a thread in the current conversation.
- **System status** opens provider and capability health.
- **Automations** opens schedules and task history.
- **Cancel active run** requests cancellation for the current run.

The service worker caches only the static shell. `/api/*` and WebSocket traffic are never cached, so sessions and agent state remain live.

## Onboarding

Run onboarding again at any time:

```bash
node dist/cli.js onboard
```

The flow controls:

- Local Ollama/OpenAI-compatible provider.
- Codex ChatGPT-subscription provider.
- Matrix phone integration.
- Local SearXNG search and DuckDuckGo fallback.
- Guarded Playwright browser tools; optional operator-managed Crawl4AI and FlareSolverr services.
- Authenticated Tailscale Serve for Synapse.
- Final launch mode: TUI, web dashboard, or skip.

Telemetry is not an opt-in question because NUAAI does not ship product telemetry. The persisted configuration records `telemetry: false` and the local service setup disables Synapse usage reporting.

## Usage

### CLI

```bash
node dist/cli.js init
node dist/cli.js daemon
node dist/cli.js status
node dist/cli.js doctor
node dist/cli.js pair [base-url]
node dist/cli.js run "Summarize the current workspace"
node dist/cli.js onboard
node dist/cli.js service install
node dist/cli.js service status
```

### TUI controls

- `Ctrl+1` through `Ctrl+8`: switch surfaces.
- `Ctrl+0`: open the command palette.
- `Ctrl+Up` / `Ctrl+Down`: select sessions.
- `Ctrl+Left` / `Ctrl+Right`: select threads.
- `Ctrl+N` on Schedules: create a schedule.
- `Ctrl+G`: trigger the first listed schedule.
- `Ctrl+E`: pause or resume the first listed schedule.
- `Ctrl+P` / `Ctrl+M`: cycle provider/model.
- `Ctrl+X`: cancel the active run or task.
- `Ctrl+R`: refresh daemon state.
- `Esc`: exit.

### Agent tools

When enabled, the daemon-owned runtime exposes:

- Workspace: `workspace.list`, `workspace.read`, `workspace.write`, `workspace.search`, `workspace.inspect`, `workspace.command`
- Web/browser: `web.search`, `web.fetch`, `browser.open`
- Durable memory: `memory.store`, `memory.search`, `memory.forget`
- Run diagnostics: `run.history` for bounded recent outcomes in the current thread
- Scheduling/tasks: `schedule.create`, `schedule.list`, `schedule.update`, `schedule.pause`, `schedule.resume`, `schedule.trigger`, `task.create`, `task.list`, `task.cancel`
- Providers: `provider.list`, `provider.status`, `provider.switch`
- Media: `media.inspect` for bounded text, image, audio, video, PDF, DOCX, and XLSX inspection
- MCP/computer-use: `mcp.status`, `mcp.discover`, `mcp.execute`, `computer.status`, `computer.use` when explicitly configured
- External agents: `agent.list`, `agent.dispatch` when explicitly allowlisted and enabled

Network-backed tools require the runtime network capability. Tool registration follows onboarding feature choices. Provider/model catalogs come from each live provider, and independent selections are persisted under `provider.selectedModels`; downloading or discovering a model does not activate it.

Authenticated Web, allowlisted Matrix, and scheduled runs default to the `operator` profile with read, write, execute, filesystem, subprocess, and network capabilities. Set any client to `read-only` under `permissions` when required. The generic command tool remains allowlisted rather than becoming an unrestricted shell; full write functionality is provided by typed workspace, memory, schedule, task, provider, MCP, and configured-agent tools.

For Matrix sessions, messages from the same room and sender reuse the same durable source-bound session. New responses are threaded to the inbound event by default; existing replies stay in the inbound thread. Use `/help` for the command list, `/status` for the active session, `/new [title]` to create a fresh session, `/sessions` to list the room's sessions, and `/switch <session-id>` to change the active session. Voice input and TTS are independent optional features: `/voice on|off|status` controls microphone/audio/video transcription, while `/tts on|off|status` controls spoken response delivery. Unknown slash commands return help instead of being sent to the model.

Matrix admission and delivery policy is daemon-owned, before model execution:

- At least one `allowedUsers` or `allowedRooms` entry is required when Matrix is enabled. An empty pair fails configuration validation instead of accepting every sender.
- `requireMention` can require a direct bot mention in shared rooms; `freeResponseRooms` can exempt private rooms.
- `ignoreUserPatterns` drops known bridge or relay senders, and `processNotices` controls whether `m.notice` events are accepted.
- `allowRoomMentions` controls whether an explicit `@room` mention can satisfy mention policy.
- Duplicate event IDs are ignored, stale timestamped events from the first sync are dropped, and outbound text is split at `maxMessageLength` without silent truncation.
- Receipts, typing state, reactions, thread relations, bounded media staging, and voice-message metadata remain Matrix-native.
- Every turn receives one stable permission-filtered tool catalog. A model call outside that catalog is rejected and never executed; repeated invalid calls fail fast instead of consuming the entire run timeout.
- Normal conversation context defaults to `1,000,000` bytes and retrieved memory defaults to `64,000` bytes. Automatic recall falls back to lexical ranking when embeddings are unavailable. Live verification and memory mutations run isolated from prior transcript and memory injection.
- Runs allow 48 tool calls by default. Reaching the budget stops further actions and forces a no-tools finalization turn from evidence already gathered instead of discarding the work as a hard failure.
- Runs allow 48 ordinary model turns plus one no-tools finalization grace turn. Streamed output is batched, reset at each provider-attempt boundary, and snapshotted durably so reconnects preserve the complete current response without combining discarded drafts.
- The central tool registry declares owner, cost class, auth mode, side effects, approval policy, and a per-run ceiling for every tool. Registry admission validates permission, input, weighted run cost, and per-tool usage before emitting `tool.started`; `computer.use`, generic MCP execution, and external-agent dispatch are execute-gated high-cost boundaries.
- When MCP is configured through the registry, models receive stable generic `mcp.discover` and `mcp.execute` tools rather than every discovered remote schema. Discovery stays available without duplicating the executable authority or inflating each provider prompt.

The current bridge does not decrypt encrypted-room events. Use an unencrypted bot room until a real Matrix crypto client is implemented; the bridge does not claim E2EE support.

## Phone access

### SSH from iOS

Install an SSH client such as Termius, Blink Shell, or Prompt. Connect using the Tailscale machine name or Tailscale IP:

```bash
ssh <local-user>@<tailscale-machine-name>
```

If MagicDNS is unavailable:

```bash
ssh <local-user>@<tailscale-ip>
```

The SSH account and key remain host configuration. NUAAI does not manage or print SSH credentials.

For a temporary tunnel to the local NUAAI dashboard:

```bash
PORT="$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('.nuaai/config.json', 'utf8')).port)")"
ssh -N -L "$PORT:127.0.0.1:$PORT" <local-user>@<tailscale-machine-name>
```

While the tunnel is active, run `nuaai pair "http://127.0.0.1:$PORT"` on the host and open the returned URL in the browser.

### Element on iOS

1. Complete onboarding with Matrix and Tailscale Serve enabled. Onboarding maps Synapse to `/` and the NUAAI web application to `/nuaai`.
2. Confirm the local Synapse container is healthy.
3. Install and open **Element Classic** on iOS. Element X requires Matrix Authentication Service (MAS), which is not part of the local Synapse deployment.
4. Select **Sign in** or **Create account**.
5. Use the Tailscale HTTPS hostname shown by `tailscale serve status` as the homeserver URL.
6. Sign in with the generated Matrix operator ID and the password stored at `deploy/local/state/synapse/.nuaai-operator-password`. The password file is owner-only and ignored by Git.
7. Create a room with encryption disabled. NUAAI currently reads standard `m.room.message` events and does not decrypt E2EE rooms.
8. Invite the NUAAI bot ID printed by the local setup command. The bridge automatically joins invited rooms.
9. Send a normal text message and wait for the daemon-backed response.
10. To use voice messages, send `/voice on`; to receive spoken responses, send `/tts on`. Both features start disabled and can be turned off with the matching `off` command.

Do not use Tailscale Funnel or a public internet bind for this setup. Serve is intended to keep Matrix inside the tailnet.

## Architecture

```text
Element iOS ── Matrix over Tailscale Serve ──┐
                                             │
Ink TUI ───────────────┐                     │
React web ─────────────┼─ authenticated ── NUAAI daemon
CLI ───────────────────┘   HTTP/WebSocket       │
                                                ├─ AgentRuntime
                                                ├─ SQLite / sqlite-vec
                                                ├─ Ollama / optional Codex
                                                ├─ ToolRegistry
                                                ├─ Scheduler
                                                ├─ SecretsManager
                                                └─ MatrixBridge

ToolRegistry ── local SearXNG ── DuckDuckGo fallback
             └─ guarded Playwright public-page boundary
```

The daemon is the source of truth. Clients do not call providers directly or maintain independent agent state.

## Configuration

`node dist/cli.js init` creates `.nuaai/config.json`. The important fields are:

```json
{
  "host": "127.0.0.1",
  "provider": {
    "name": "ollama",
    "model": "qwen3.5:latest",
    "selectedModels": {
      "ollama": "qwen3.5:latest"
    },
    "baseUrl": "http://127.0.0.1:11434"
  },
  "features": {
    "ollama": true,
    "codex": false,
    "matrix": false,
    "search": true,
    "browser": true,
    "telemetry": false
  },
  "permissions": {
    "web": "operator",
    "matrix": "operator",
    "scheduler": "operator"
  },
  "limits": {
    "runTimeoutMs": 960000,
    "maxContextBytes": 32000,
    "maxMemoryContextBytes": 8000
  },
  "matrix": {
    "enabled": true,
    "homeserverUrl": "https://matrix.example",
    "userId": "@nuaai:example",
    "allowedUsers": ["@operator:example"],
    "allowedRooms": [],
    "freeResponseRooms": [],
    "ignoreUserPatterns": [],
    "requireMention": true,
    "processNotices": false,
    "allowRoomMentions": false,
    "autoThread": true,
    "reactions": true,
    "maxMessageLength": 16000
  },
  "audio": {
    "voiceEnabled": false,
    "ttsEnabled": false,
    "pythonCommand": "/path/to/voice-agent/.venv/bin/python",
    "scriptPath": "scripts/voice-bridge.py",
    "outputDirectory": ".nuaai/audio",
    "model": "small",
    "device": "cpu",
    "computeType": "int8",
    "voice": "af_sarah",
    "kokoroModelPath": "/path/to/kokoro-v1.0.onnx",
    "kokoroVoicesPath": "/path/to/voices-v1.0.bin"
  }
}
```

The audio paths are local configuration examples only. Do not commit host-specific paths or model assets. `voiceEnabled` and `ttsEnabled` are independent startup defaults; Matrix commands can toggle either feature for the running daemon.

NUAAI generates distinct high loopback ports for the daemon, Synapse, SearXNG, Crawl4AI, and FlareSolverr during initialization. The generated values are written to `.nuaai/config.json` and the ignored Docker environment file; do not copy fixed service-port examples into production configuration.

Secrets and tokens belong in ignored local runtime files or the encrypted secrets manager. Message, run, compaction, and memory content is durable local data and is not generic secret storage. Do not put credentials in prompts or committed configuration.

## Privacy and telemetry

NUAAI does not include product analytics, crash reporting, hosted tracing, or background telemetry. Runtime state stays on the host unless an explicitly enabled provider or web integration sends a request as part of a user-approved operation.

The boundaries are concrete:

- Ollama requests stay on the local Ollama endpoint.
- Codex turns send prompts, tool schemas, and tool observations to the fixed ChatGPT Codex Responses endpoint. The access token is read from the Codex CLI auth store on demand; refresh remains Codex-owned and OAuth state is never copied into NUAAI configuration, events, or the database.
- SearXNG is local, but search engines configured inside SearXNG may receive queries.
- Model-facing page requests use Playwright and reject local, private, link-local, credential-bearing, unsafe-port, redirect, and private-subresource destinations. Service workers and WebSockets are disabled, and Crawl4AI and FlareSolverr are not automatic untrusted-URL fallbacks. Browser DNS resolution is not IP-pinned, so deployments should retain egress filtering rather than treating this application guard as a network sandbox.
- Synapse usage reporting is disabled in the local Docker setup.
- Matrix messages remain within the configured Synapse deployment and the tailnet path.

## Security boundaries

- The daemon binds to loopback by default.
- HTTP and WebSocket routes require generated local bearer authentication.
- Loading the browser shell does not issue credentials; browser access requires an explicit `nuaai pair` URL.
- Synapse and search services bind to loopback through the supplied Compose file.
- Tailscale Serve is opt-in and tailnet-scoped; Funnel is not used.
- Workspace paths reject traversal, symlink escapes, and multi-link regular files that could alias protected data.
- Commands are restricted to an allowlist and bounded by timeout/output limits.
- Secret-manager values are encrypted at rest and omitted from list/status/event responses; durable conversation and memory text is stored verbatim.
- Runtime state, `.env` files, Matrix tokens, generated Synapse state, and Docker secrets are ignored by Git.
- Encrypted Matrix events are ignored because the current bridge has no crypto client; use an unencrypted bot room.

Review [`docs/SECURITY.md`](docs/SECURITY.md) before exposing any service beyond loopback.

## Verification

Run the complete local gate:

```bash
npm run gate
git diff --check
```

The gate runs Biome, strict TypeScript, 80% per-file coverage across the instrumented runtime/core library scope, fresh Node/web builds, browser E2E, an installed-tarball daemon smoke, version consistency, and a dependency audit that blocks moderate-or-higher advisories. Process entrypoints, React/Ink presentation code, schema declarations, and provider transport shims are verified through integration, build, E2E, and artifact tests rather than included in the percentage claim. The current remaining low advisory is confined to tsup's Windows-only development-server esbuild dependency; NUAAI does not ship or run that server.

The repository includes unit, integration, runtime, and browser tests. Live service smoke tests require Docker and are intentionally separate from deterministic unit tests.

## Roadmap

- [x] Durable local agent runtime and SQLite persistence.
- [x] Ink TUI, React web dashboard, CLI, and authenticated gateway.
- [x] Ollama and optional Codex provider boundaries.
- [x] Local SearXNG, Crawl4AI, DuckDuckGo, Playwright, and FlareSolverr integration boundaries.
- [x] Shared public-destination policy for model-facing browser and page-fetch tools.
- [x] Matrix bridge with local Synapse bootstrap and invite auto-join.
- [x] Interactive onboarding with telemetry disabled by default.
- [ ] Encrypted Matrix room support.
- [ ] Provider-specific per-tool network policies.
- [ ] Published npm release after the public GitHub release gate.

## Contributing

1. Fork the repository.
2. Create a focused branch.
3. Make the smallest change that solves the issue.
4. Add or update behavioral tests.
5. Run the complete verification gate.
6. Open a pull request with the behavior changed and the commands run.

Do not commit `.env` files, `.nuaai/`, Docker state, provider tokens, Matrix credentials, browser profiles, or generated build output.

## License

Distributed under the MIT License. See [`LICENSE`](LICENSE).

## Acknowledgments

- [Ollama](https://ollama.com/) for local model serving.
- [Matrix](https://matrix.org/) and [Synapse](https://github.com/element-hq/synapse) for the open messaging protocol and homeserver.
- [SearXNG](https://docs.searxng.org/) for metasearch.
- [Crawl4AI](https://github.com/unclecode/crawl4ai) for local crawling.
- [Playwright](https://playwright.dev/) for browser automation.
- [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) for locally controlled challenge handling.
- [Tailscale Serve](https://tailscale.com/kb/1247/funnel-serve-use-cases) for tailnet-scoped HTTPS access.
- [Best README Template](https://github.com/othneildrew/Best-README-Template) for the documentation structure.

<p align="right">(<a href="#readme-top">back to top</a>)</p>
