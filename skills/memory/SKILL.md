---
name: memory
description: Use when the user asks to remember, recall, search, update, or forget durable information. Use the real memory tools and never treat model memory or retrieved notes as proof of current capabilities.
license: MIT
compatibility: Requires the NUAAI memory tools and the current permission context.
metadata:
  author: tylerdotai
  version: "1.0"
  triggers: "remember, memory, recall, forget, save this, what do you remember, notes, durable preference, retain"
allowed-tools: "memory.store memory.search memory.forget"
---

# Durable Memory

Use `memory.search` to retrieve, `memory.store` to persist, and `memory.forget` to remove a specific record. Tool results are authoritative.

- Never store passwords, access tokens, API keys, secrets, private credential contents, or raw connection strings.
- Do not claim that a fact was remembered until `memory.store` returns success and an identifier.
- Do not claim that no memory exists until `memory.search` returns no matching results.
- Treat retrieved memory as context, not current system state or a capability list.
- Forget operations are destructive and require the user’s explicit request for the target record.

See [references/memory-contract.md](references/memory-contract.md).
