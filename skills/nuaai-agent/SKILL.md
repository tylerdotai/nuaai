---
name: nuaai-agent
description: Operate NUAAI as a persistent local-first agent harness. Use when handling NUAAI sessions, threads, Matrix or Element conversations, local models, workspace tools, permissions, skills, memory, schedules, or verified tool execution.
license: MIT
compatibility: Designed for the NUAAI daemon, authenticated clients, local Ollama, and the workspace tool boundary.
metadata:
  author: tylerdotai
  version: "1.0"
  triggers: "nuaai, agent harness, local model, ollama, session, thread, matrix, element, skill, memory, schedule, workspace tool, tooling, tool access, capability, browser, desktop, computer, cli"
allowed-tools: "workspace.list workspace.read workspace.inspect workspace.write workspace.search workspace.command web.search web.fetch browser.open memory.store memory.search memory.forget run.history schedule.create schedule.list schedule.update schedule.pause schedule.resume schedule.trigger task.create task.list task.cancel provider.list provider.status provider.switch mcp.status mcp.discover mcp.execute computer.status computer.use media.inspect agent.list agent.dispatch"
---

# NUAAI Agent Operating Skill

## Operating contract

1. Treat the NUAAI daemon as the source of truth for sessions, threads, runs, tools, permissions, memory, schedules, providers, and skills.
2. Use an available tool for an action. A model claim is never evidence that an action happened.
3. Read the tool result before reporting completion. Preserve exact failures when a tool fails.
4. Keep secrets, runtime databases, tokens, private configuration, and environment files protected.
5. Use the smallest safe action that satisfies the request. Do not chain shell commands through model-facing command tools.

## Sessions and threads

- Reuse the current client source identity instead of creating a session for every message.
- Create a new session only when the user asks for a new conversation or the client has no durable session.
- Use a new thread for a distinct topic inside an existing session.
- Keep Matrix and Element thread relations attached to the originating event so replies remain visible in the correct thread.

## Tool execution

- Inspect the current available-tool list in the system context. The current NUAAI tool families are:
  - Workspace: `workspace.list`, `workspace.read`, `workspace.inspect`, `workspace.write`, `workspace.search`, `workspace.command`.
  - GitHub: `github.auth`, `github.repo.list` for sanitized authentication and bounded repository queries.
  - Web/browser: `web.search`, `web.fetch`, `browser.open` when the browser feature is enabled.
  - Memory: `memory.store`, `memory.search`, `memory.forget`.
  - Run diagnostics: `run.history` lists bounded recent outcomes only for the current thread.
  - Scheduling/tasks: `schedule.create`, `schedule.list`, `schedule.update`, `schedule.pause`, `schedule.resume`, `schedule.trigger`, `task.create`, `task.list`, `task.cancel`.
  - Providers: `provider.list`, `provider.status`, `provider.switch`.
  - MCP/computer: `mcp.status`, `mcp.discover`, `mcp.execute`, `computer.status`, `computer.use` when configured.
  - Media/agents: `media.inspect`, `agent.list`, `agent.dispatch` when configured.
- A tool family listed here is not proof that the current run has it. The per-run `Available tools` catalog is authoritative; only call names present there.
- Call one tool at a time when results affect the next action.
- Never claim a command, file edit, search, upload, model switch, or test succeeded without the corresponding verified result.
- If a permission context hides a tool, report the actual limitation rather than guessing or requesting unavailable access.
- Never self-report “I have no tools” or “I cannot access the workspace” from model memory. If the catalog contains a relevant tool, call it; if the call fails, report the returned failure.

## Skills and learning

- Use trigger words in skill metadata to decide when a skill is relevant.
- Load a full skill body only after a trigger match; load referenced files only when required.
- To save a repeatable workflow, use an explicit request such as `learn skill <name>: <workflow>`. Automatic learning writes a private standard skill only after a successful run.
- Keep learned procedures concise, auditable, and free of secrets or transient outputs.

## Verification

For any multi-step action, report the concrete evidence: resource ID, event ID, run status, test result, or file path. If evidence is missing, the action is not complete.

See [references/daemon-client-contract.md](references/daemon-client-contract.md) for daemon startup, Matrix/Element troubleshooting, thread identity, and authenticated client checks.
Run `node scripts/verify-daemon.mjs` for a bounded health and authentication smoke check.
