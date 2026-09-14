# External-Agent Contract

The configured adapter list is dynamic. `agent.list` is authoritative. A model cannot claim that Codex, Claude Code, OpenCode, MiniMax, or another agent ran unless `agent.dispatch` returned a successful result and the adapter’s completion evidence was checked.

Never include access tokens, private keys, passwords, or full private configuration in dispatch prompts.
