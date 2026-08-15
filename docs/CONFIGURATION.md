# Configuration and Provider Setup

`nuai init` creates `.nuai/config.json`. Configuration is local runtime state and must not be committed.

```json
{
  "version": 1,
  "name": "NUAI",
  "host": "127.0.0.1",
  "port": 8787,
  "provider": {
    "name": "ollama",
    "model": "qwen3.5:latest",
    "baseUrl": "http://127.0.0.1:11434"
  },
  "embedding": {
    "model": "nomic-embed-text:latest",
    "baseUrl": "http://127.0.0.1:11434"
  }
}
```

Runtime limits are available under `limits`: `maxTurns`, `maxToolCalls`, `maxOutputBytes`, `runTimeoutMs`, `providerTimeoutMs`, and `toolTimeoutMs`.

## Ollama

Ollama is the primary local provider. Verify installation and models:

```bash
ollama --version
ollama list
```

The provider uses `/api/tags`, `/api/chat`, `/api/embed`, and the legacy `/api/embeddings` fallback. A real local verification on this host used `qwen2.5:0.5b` for chat and `nomic-embed-text:latest` for embeddings. The provider returned streamed deltas and a 768-dimensional embedding.

## Codex

Codex is optional and runs through the installed CLI. The adapter uses the verified non-interactive JSONL contract:

```text
codex exec --json --ephemeral --sandbox read-only --cd <workspace> \
  --skip-git-repo-check [--model <model>] <prompt>
```

The adapter captures stdout/stderr, closes stdin immediately, handles non-zero exits, timeouts, abort signals, JSONL parsing, and provider health. `codex exec --help` was used to verify flags; `--ask-for-approval` is not an `exec` flag and is intentionally not passed. When the Codex model is unset, NUAI omits `--model` and delegates model selection to the authenticated Codex CLI. `--skip-git-repo-check` allows safe read-only workspaces that are not Git repositories.

Codex hosted authentication is external provider state. A local no-billing CLI probe can use:

```bash
codex exec --json --ephemeral --oss --local-provider ollama \
  --sandbox read-only --cd "$PWD" --model qwen2.5:0.5b \
  "Reply with a short plain-text response"
```

Small local OSS models may emit unsupported tool calls or time out. NUAI records that failure rather than treating it as a successful generation.

## Master key

Secrets use `NUAI_MASTER_KEY` when set. If absent, NUAI creates a local `.nuai/master.key` with restrictive permissions. Secret values are never returned by API list routes or persisted events.
