# Configuration and Provider Setup

`nuaai init` creates `.nuaai/config.json`. Configuration is local runtime state and must not be committed.

## Core configuration

```json
{
  "version": 1,
  "name": "NUAAI",
  "host": "127.0.0.1",
  "web": {
    "publicBasePath": "/"
  },
  "provider": {
    "name": "ollama",
    "model": "qwen3.5:latest",
    "selectedModels": {
      "ollama": "qwen3.5:latest"
    },
    "baseUrl": "http://127.0.0.1:11434",
    "codex": {
      "executable": "codex",
      "timeoutMs": 900000
    }
  },
  "embedding": {
    "model": "nomic-embed-text:latest",
    "baseUrl": "http://127.0.0.1:11434"
  },
  "permissions": {
    "web": "operator",
    "matrix": "operator",
    "scheduler": "operator"
  },
  "limits": {
    "runTimeoutMs": 960000
  }
}
```

Runtime limits are available under `limits`: `maxTurns`, `maxToolCalls`, `maxOutputBytes`, `runTimeoutMs`, `providerTimeoutMs`, `toolTimeoutMs`, `maxContextBytes`, and `maxMemoryContextBytes`. Keep `runTimeoutMs` above the longest enabled provider timeout so the outer agent loop cannot abort a provider first.

`maxToolCalls` defaults to `48`. When the budget is exhausted, NUAAI rejects additional calls coherently, removes the tool catalog for the next turn, and asks the model to finalize from completed evidence rather than failing the run immediately.

`permissions.web`, `permissions.matrix`, and `permissions.scheduler` accept `operator` or `read-only`. `operator` is the production default for authenticated/allowlisted clients and enables typed read, write, and execute tools inside configured boundaries. `read-only` remains available as an explicit deployment choice.

`provider.selectedModels` retains an independent last-known model for each provider. Local-provider catalogs are discovered from live `/models` or `/api/tags` responses. Codex uses the visible entries in the authenticated CLI's local model cache; hidden model routes are not injected into the interface.

Initialization generates distinct high loopback ports for the daemon and local integration services. Read generated values from `.nuaai/config.json` and `deploy/local/.env.integrations`; do not hardcode service ports.

## Local provider: Ollama or OpenAI-compatible

Ollama is the default portable local server. Verify installation and models:

```bash
ollama --version
ollama list
```

The adapter selects protocol from the configured base URL:

- Base URL ending in `/v1`: OpenAI-compatible `/chat/completions`, `/models`, and `/embeddings`. This supports llama.cpp and other local OpenAI-compatible servers.
- Other base URL: native Ollama `/api/tags`, `/api/chat`, `/api/embed`, and legacy `/api/embeddings` fallback.

Chat and embedding availability are independent. A local chat server may return `501` for embeddings unless launched with embedding support. NUAAI reports that failure and continues without inventing a vector result. Configure `embedding.model` and `embedding.baseUrl` only against an embedding-capable server.

## Codex Responses

Codex is optional and uses ChatGPT OAuth from the installed Codex CLI. Verify the CLI and login before enabling the provider:

```bash
codex --version
codex login status
```

Configuration:

```json
{
  "provider": {
    "name": "codex",
    "model": "gpt-5.6-sol",
    "codex": {
      "executable": "codex",
      "timeoutMs": 900000
    }
  }
}
```

Model turns stream from `https://chatgpt.com/backend-api/codex/responses`; the endpoint is fixed and redirects are rejected so bearer credentials cannot cross hosts. NUAAI reads the current access token from the Codex auth store for each turn, derives the required account header from the JWT, and never stores OAuth material in project configuration, SQLite, events, or logs. Near expiry, a sanitized short-lived App Server process receives only an explicit `CODEX_HOME` and performs `account/read` with `refreshToken: true`; Codex remains the sole writer and rotator of its credential store. Tools, workspace containment, execution permission, cancellation, and result verification remain owned by the NUAAI runtime.

Legacy `sandboxMode`, `approvalPolicy`, and `postToolQuietTimeoutMs` values are ignored and removed during configuration parsing. Those settings governed the retired App Server turn path; current Codex actions use `permissions.web`, `permissions.matrix`, or `permissions.scheduler` like every other provider.

## Matrix

The integration bootstrap creates `.nuaai/matrix.env` with the bot token, bot user ID, and loopback homeserver URL. `loadRuntimeConfig` reads that file automatically and does not override values already exported in the process environment. Bot/operator accounts use Synapse shared-secret provisioning; public registration remains disabled.

Matrix admission fails closed. Enabling Matrix requires a static user or room allowlist:

```json
{
  "matrix": {
    "enabled": true,
    "homeserverUrl": "http://127.0.0.1:<generated-port>",
    "userId": "@nuaai:<server-name>",
    "allowedUsers": ["@operator:<server-name>"],
    "allowedRooms": [],
    "requireMention": true,
    "processNotices": false,
    "autoThread": true,
    "reactions": true
  }
}
```

Do not place the access token in committed JSON. Use `.nuaai/matrix.env` or `NUAAI_MATRIX_ACCESS_TOKEN`.

The supplied Compose stack includes pinned Synapse plus SearXNG, Crawl4AI, and FlareSolverr. Onboarding starts only selected services and installs the package-pinned Playwright Chromium runtime when browser automation is selected. Model-facing `web.fetch` and `browser.open` use guarded Playwright, falling back from a missing managed Chromium revision to configured or installed system Chrome. Playwright disables service workers and WebSockets, blocks redirects and protocol upgrades, and validates every direct HTTP request as public HTTP(S) before fetching it. Browser DNS resolution is not IP-pinned, so retain host/container egress filtering. Crawl4AI and FlareSolverr remain standalone clients for explicitly trusted operator workflows; they are not automatic fallbacks for model-supplied URLs because application pre/post validation cannot constrain redirects inside an external sidecar. Validate without starting services:

```bash
cd deploy/local
docker compose --env-file .env.integrations config --quiet
```

Start explicitly through onboarding or Compose. Generated Synapse state remains under ignored `deploy/local/state/`.

## User service

Build the project before installing the user unit:

```bash
npm run build:release
nuaai service install
nuaai service status
```

Installation writes `~/.config/systemd/user/nuaai.service`, applies an owner-only umask, and reloads the user service manager. Installation does not start or enable the daemon.

Explicit lifecycle commands:

```bash
nuaai service start
nuaai service restart
nuaai service stop
```

## Tailscale Serve

When selected during onboarding, NUAAI configures:

- tailnet root `/` → generated loopback Synapse port;
- `/nuaai` → generated loopback NUAAI daemon port.

Onboarding also sets `web.publicBasePath` to `/nuaai`. This preserves the mount-scoped browser cookie when Tailscale strips the public prefix before proxying to the daemon. Root-mounted deployments keep the default `/`. Custom reverse proxies can set the same value through `NUAAI_PUBLIC_BASE_PATH`.

Inspect current routes with `tailscale serve status`. NUAAI does not use Tailscale Funnel.

## Master key and durable text

Secret-manager values use `NUAAI_MASTER_KEY` when set. If absent, NUAAI creates `.nuaai/master.key` with restrictive permissions. Secret values are never returned by API list routes or persisted as secret records in events.

Conversation messages, run input/output, compacted transcript text, and memory content are stored verbatim as durable operator data. Do not put credentials in prompts or saved memory.
