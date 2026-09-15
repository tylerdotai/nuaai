# Security Model

NUAAI is designed for one local operator on a loopback-bound host. Tailscale Serve can make selected loopback services reachable to authenticated tailnet members; Tailscale Funnel and public binds are outside the supported v1 deployment.

## Default controls

- The daemon binds to `127.0.0.1` by default.
- HTTP API routes require a generated HMAC bearer token. Loading the static browser shell issues no credential. `nuaai pair [base-url]` creates a five-minute, browser-pairing-only token in the URL fragment. The client removes that fragment from browser history before sending the exchange request, then receives a separate 30-day HTTP-only, same-site cookie scoped to the actual app mount. Pairing tokens cannot authenticate HTTP API or WebSocket routes, and runtime bearer tokens cannot be exchanged for browser cookies.
- WebSocket connections validate the token and cap inbound messages at 64 KiB.
- HTTP request bodies are rejected above 1 MiB before application routing.
- Runtime identity is stored in Git-ignored `.nuaai/runtime.json`; expired tokens rotate on the next startup.
- Authenticated Web, allowlisted Matrix, and scheduled runs default to the configurable `operator` profile. Operator mode enables typed read, write, and execute tools while preserving workspace containment, protected-path checks, subprocess sanitization, and daemon authentication. `read-only` is an explicit per-client profile.
- Profile-governed tools require a separate per-action operator decision. The daemon pauses before side effects, hashes the run ID, canonical registry tool name, and canonical arguments, and persists only that hash plus a versioned tool-specific allowlisted preview. Opaque content, prompts, command arguments, typed values, and signed URLs are never copied into the preview or target; cards expose labeled size/fingerprint facts plus safe path/action/coordinate/element and client/session context. Approve/deny requests must echo the displayed hash. Execution revalidates current permission, tool authority, payload hash, status, and expiry, then atomically consumes the approval once before invoking the handler.
- Provider-owned lifecycle events are not trusted directly. Dynamic-tool callbacks require exact call metadata and record qualified tool name, call ID, argument hash, result hash, and status; unadvertised, fabricated, missing, duplicated, or mismatched events fail the run and cannot create trusted tool completion evidence.
- Authenticated WebSockets send payload-free approval-inbox invalidations across session subscriptions. Full lifecycle events retain their session scope, and the PWA generation-fences concurrent refreshes so stale responses cannot restore a decided or expired action.
- Codex model requests use a fixed HTTPS endpoint with redirects disabled. OAuth access is read on demand from the Codex CLI store and never persisted in NUAAI state; near-expiry refresh is delegated to a sanitized Codex-owned account RPC. Codex tool calls still pass through the same NUAAI permission profile and workspace boundary as local providers.
- Workspace writes reject traversal, protected runtime files, symlink targets, and multi-link regular files. Project file reads reject credential-like files, Git metadata, hard-link aliases, and paths that resolve outside the project root.
- The generic command tool uses an explicit read-oriented allowlist, a minimal subprocess environment, safe process-listing columns, validated file arguments, no shell, bounded time/output, and no generic interpreter, package-manager, VCS, provider-CLI, or path-qualified executable access.
- Model-triggered provider, media/audio, MCP, plugin, workspace-command, and external-agent subprocesses receive explicit minimal environments. Additional adapter variables must be allowlisted by configuration.
- Model-facing browser and page-fetch URLs must resolve exclusively to public addresses on ports 80 or 443 and cannot contain credentials. Playwright disables service workers and WebSockets, blocks redirects and protocol upgrades, and revalidates each direct HTTP request before fetching it. Browser DNS resolution is not IP-pinned, so host/container egress filtering remains required for defense in depth. Local integration endpoints are reached only through fixed configuration-owned clients.
- Persistent skill learning requires both write permission and filesystem capability; read-only runs cannot install prompt instructions.
- Runtime directories are private and SQLite database files are created with owner-only permissions.
- Durable run-artifact capture accepts only supported kind/MIME pairs, bounded JSON metadata, bounded content, and HTTPS external URLs without userinfo, queries, or fragments. Workspace sources must be relative regular files inside the project root; traversal, symbolic links, hard links, protected runtime/Git/credential paths, and oversized sources are rejected. Storage-root and run-directory entries are opened with no-follow semantics, checked by inode, physically resolved inside the private runtime root, and forced to owner-only mode before an immutable exclusive file is opened. Captured bytes are verified against their recorded size and SHA-256 before download.
- Interrupted runs are marked failed and require explicit manual resume instead of replaying prior actions automatically.
- Pending approval runs are the exception to interrupted model-run recovery: the pending request remains durable. Approval resumes the same run, but the provider must re-propose an action whose canonical payload matches the stored hash; NUAAI never reconstructs an action from a preview.
- Matrix fails configuration validation unless at least one `allowedUsers` or `allowedRooms` entry exists.
- Synapse and local integration ports bind to loopback through the supplied Compose file. Synapse is pinned to an explicit release tag, and public account registration remains disabled after shared-secret bot/operator provisioning.
- No system service is enabled automatically. `nuaai service install` writes and reloads a private user unit; start and enable remain explicit operator actions.

## Data handling

- Secret-manager values use AES-256-GCM and are not returned by list/status routes.
- Events, internal tool metadata, and run-artifact metadata/provenance pass through redaction before persistence and delivery. Text-like run-artifact content is also sanitized before storage. Its metadata explicitly records `contentSanitized: true` and `checksumScope: stored-sanitized-bytes`; the checksum never claims byte-for-byte source identity. Binary content is copied without text transformation and records `checksumScope: stored-bytes`; external-only citations checksum the canonical HTTPS URL and record `checksumScope: external-url`. Provider stderr is byte-bounded; remote response bodies, terminal control codes, bearer credentials, API keys, and personal home-directory segments are omitted or redacted before an error can enter durable run state.
- Artifact list, detail, and download routes require normal daemon authentication and return 404 for unknown or cross-run IDs. Downloads use attachment disposition, `nosniff`, private no-store caching, immutable checksum verification, and strict single-range handling with 416 responses for invalid ranges. Private storage-relative paths are never returned to clients.
- Conversation messages, run input/output, compacted transcript text, and memory content are durable operator data and are stored verbatim. Compaction checkpoints are reused only under the recorded summary budget, summarizer version, policy version, source hash, and a currently valid summary estimate. Do not place credentials in prompts or memory.
- `.nuaai/`, `.env*`, Matrix tokens, generated Synapse state, local media, and build artifacts are excluded from Git.
- Matrix v1 does not decrypt encrypted-room events. Use an unencrypted bot room inside the private tailnet deployment.

## Local extension trust

Skills and plugins are local extensions, not a remote marketplace. First-party MIT skills ship inside the package and load independently of the runtime workspace. Private manifests must be marked trusted and pass validation; local trusted executable extension code still runs with host-level filesystem access. Model-facing workspace tools cannot write `.nuaai/skills` or `.nuaai/plugins`. Review extension source before operator installation.

## Remote access

Onboarding can configure two Tailscale Serve routes:

- `/` → loopback Synapse
- `/nuaai` → loopback NUAAI daemon

Serve remains tailnet-scoped. Tailnet members can reach the static shell, but cannot obtain an authenticated cookie without an explicit pairing token generated on the host. Tailnet membership remains part of the network trust boundary. Do not use Funnel or forward these routes through a public proxy.
