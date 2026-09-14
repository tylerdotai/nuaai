---
name: agent-dispatch
description: Use when the user asks to list configured external agents or dispatch bounded work to Codex, Claude, OpenCode, MiniMax, or another explicitly configured agent adapter. Verify the adapter exists and report the returned task result.
license: MIT
compatibility: Requires an explicitly configured allowlisted external-agent adapter. No adapter means no external-agent execution.
metadata:
  author: tylerdotai
  version: "1.0"
  triggers: "external agent, dispatch agent, delegate, Codex, Claude Code, OpenCode, MiniMax, subagent, agent adapter, hand off"
allowed-tools: "agent.list agent.dispatch"
---

# Bounded External-Agent Dispatch

1. Call `agent.list` before naming or dispatching an adapter.
2. Dispatch only an adapter returned by that result.
3. Keep the prompt bounded and omit secrets, credentials, and unnecessary private data.
4. A dispatch acknowledgement is not completion. Report the returned task/run identifier and verify completion when the adapter provides it.
5. If no adapter is configured, say so plainly instead of claiming another agent was contacted.

See [references/agent-contract.md](references/agent-contract.md).
