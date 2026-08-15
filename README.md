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

The default path is local Ollama. Optional integrations are explicit: Codex uses its installed CLI boundary, search starts with local SearXNG, page extraction uses local Crawl4AI, browser automation uses Playwright, challenge handling can use local FlareSolverr, and phone messaging uses a local Synapse homeserver reachable through authenticated Tailscale Serve.

## What ships

- Durable SQLite runtime with sessions, threads, messages, runs, events, memories, tasks, schedules, skills, plugins, and vector rows.
- Observe → plan → act runtime loop with streaming, cancellation, timeouts, bounded output, and restart recovery.
- Ollama chat and embedding adapters through the local HTTP API.
- Optional Codex CLI adapter using `codex exec --json`.
- Matrix bridge with invite auto-join and outbound replies.
- Local web search through SearXNG with DuckDuckGo fallback.
- Local page extraction through Crawl4AI → Playwright → FlareSolverr fallback order.
- Headless Playwright browser automation with HTTP/HTTPS URL validation.
- AES-256-GCM encrypted secrets and redacted API/UI output.
- Workspace traversal and symlink protection, command allowlists, subprocess timeouts, and daemon authentication.
- Ink TUI, React web dashboard, CLI commands, and authenticated HTTP/WebSocket APIs.
- Interactive onboarding with provider, integration, telemetry, Tailscale, and launch choices.

## Getting started

### Prerequisites

- Node.js 22 or newer.
- npm.
- Ollama for the default local provider.
- Docker Engine and Docker Compose for Synapse, SearXNG, Crawl4AI, and FlareSolverr.
- Tailscale for phone access from outside the host's local network.
- Codex CLI only if the Codex provider is enabled.

### Install from a checkout

```bash
git clone https://github.com/tylerdotai/nuaai.git
cd nuaai
npm install
npm run build
npm run build:web
```

### One-line GitHub onboarding

This command pulls the repository, installs the package, and opens the interactive onboarding flow:

```bash
npx --yes github:tylerdotai/nuaai onboard
```

The onboarding flow asks which providers and integrations to enable, keeps telemetry disabled, optionally runs the local Docker setup, optionally exposes Synapse through Tailscale Serve, and offers `tui`, `web`, or `skip` as the final launch choice.

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

## Onboarding

Run onboarding again at any time:

```bash
node dist/cli.js onboard
```

The flow controls:

- Ollama provider.
- Codex CLI provider.
- Matrix phone integration.
- Local SearXNG search and DuckDuckGo fallback.
- Playwright and FlareSolverr browser tools.
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
node dist/cli.js run "Summarize the current workspace"
node dist/cli.js onboard
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

When enabled, the runtime exposes:

- `workspace.list`
- `workspace.read`
- `workspace.write`
- `workspace.search`
- `workspace.command`
- `web.search`
- `web.fetch`
- `browser.open`

Network-backed tools require the runtime network capability. Tool registration follows onboarding feature choices.

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

Then open `http://127.0.0.1:$PORT` in a browser on the phone while the tunnel is active.

### Element on iOS

1. Complete onboarding with Matrix and Tailscale Serve enabled.
2. Confirm the local Synapse container is healthy.
3. Install and open **Element Classic** on iOS. Element X requires Matrix Authentication Service (MAS), which is not part of the local Synapse deployment.
4. Select **Sign in** or **Create account**.
5. Use the Tailscale HTTPS hostname shown by `tailscale serve status` as the homeserver URL.
6. Create or sign in to a local Matrix account.
7. Create a room with encryption disabled. NUAAI currently reads standard `m.room.message` events and does not decrypt E2EE rooms.
8. Invite the NUAAI bot ID printed by the local setup command. The bridge automatically joins invited rooms.
9. Send a normal text message and wait for the daemon-backed response.

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
             └─ Crawl4AI ── Playwright ── FlareSolverr
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
    "baseUrl": "http://127.0.0.1:11434"
  },
  "features": {
    "ollama": true,
    "codex": false,
    "matrix": false,
    "search": true,
    "browser": true,
    "telemetry": false
  }
}
```

NUAAI generates distinct high loopback ports for the daemon, Synapse, SearXNG, Crawl4AI, and FlareSolverr during initialization. The generated values are written to `.nuaai/config.json` and the ignored Docker environment file; do not copy fixed service-port examples into production configuration.

Secrets and tokens belong in ignored local runtime files or the encrypted secrets manager. Do not put credentials in the committed configuration.

## Privacy and telemetry

NUAAI does not include product analytics, crash reporting, hosted tracing, or background telemetry. Runtime state stays on the host unless an explicitly enabled provider or web integration sends a request as part of a user-approved operation.

The boundaries are concrete:

- Ollama requests stay on the local Ollama endpoint.
- Codex requests use the Codex CLI and may reach the configured Codex provider.
- SearXNG is local, but search engines configured inside SearXNG may receive queries.
- Crawl4AI, Playwright, and FlareSolverr fetch the requested external pages.
- Synapse usage reporting is disabled in the local Docker setup.
- Matrix messages remain within the configured Synapse deployment and the tailnet path.

## Security boundaries

- The daemon binds to loopback by default.
- HTTP and WebSocket routes require generated local bearer authentication.
- Synapse and search services bind to loopback through the supplied Compose file.
- Tailscale Serve is opt-in and tailnet-scoped; Funnel is not used.
- Workspace paths reject traversal and symlink escapes.
- Commands are restricted to an allowlist and bounded by timeout/output limits.
- Provider secrets are encrypted at rest and omitted from list/status/event responses.
- Runtime state, `.env` files, Matrix tokens, generated Synapse state, and Docker secrets are ignored by Git.
- Encrypted Matrix rooms are not supported by the current bridge; use an unencrypted bot room.

Review [`docs/SECURITY.md`](docs/SECURITY.md) before exposing any service beyond loopback.

## Verification

Run the complete local gate:

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
```

The repository includes unit, integration, runtime, and browser tests. Live service smoke tests require Docker and are intentionally separate from deterministic unit tests.

## Roadmap

- [x] Durable local agent runtime and SQLite persistence.
- [x] Ink TUI, React web dashboard, CLI, and authenticated gateway.
- [x] Ollama and optional Codex provider boundaries.
- [x] Local SearXNG, Crawl4AI, DuckDuckGo, Playwright, and FlareSolverr integration boundaries.
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
