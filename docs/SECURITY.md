# Security Model

NUAI is designed for one local operator on a loopback-bound host.

- The daemon binds to `127.0.0.1` by default.
- HTTP API routes require the generated bearer token.
- WebSocket connections validate the same token through the query parameter or cookie.
- The token is stored in `.nuai/runtime.json`, which is Git-ignored and never printed at daemon startup.
- Secrets are encrypted with AES-256-GCM and values are redacted from events, API responses, and UI state.
- Workspace paths are resolved below the configured workspace root and existing symlinks are checked with `realpath`.
- Workspace commands use an explicit allowlist, bounded timeout, captured stdout/stderr, and output caps.
- Codex runs through `execa` with argument arrays, no shell, a read-only sandbox, a configured workspace, timeout, abort signal, and JSONL capture.
- Untrusted skills and plugins are refused. Trusted local manifests must declare capabilities; plugin code is not granted an unrestricted marketplace or remote-install path.
- `.nuai/`, `.env*`, runtime identity files, master keys, and generated build artifacts are excluded from Git.

No system service is enabled automatically and no remote access is configured by the project.
