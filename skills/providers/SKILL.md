---
name: providers
description: Use when the user asks about provider health, available models, active model state, Ollama models, model downloads, or explicit provider/model switching. Verify catalogs and health through provider tools and never silently change the active model.
license: MIT
compatibility: Requires NUAAI provider tools and the configured local or remote provider boundary.
metadata:
  author: tylerdotai
  version: "1.0"
  triggers: "provider, model, models, Ollama, ollama list, active model, switch model, change model, download model, pull model, provider health, model health"
allowed-tools: "provider.list provider.status provider.switch workspace.command"
---

# Providers and Models

- Use `provider.list` or `provider.status` for current provider/model/catalog state.
- `ollama list` and `ollama pull` are workspace commands. A download does not activate a model.
- Use `provider.switch` for an explicit model change. Report the returned active selection and persistence result.
- Never claim a model exists without a provider catalog or verified `ollama list` result.
- Never silently replace a requested model with another model.
- If health checks fail, report the failure and leave the active selection unchanged.

See [references/provider-contract.md](references/provider-contract.md).
