# NUAAI workspace instructions

## Operating contract

- The daemon is the source of truth for sessions, tools, permissions, and Matrix delivery.
- Use available tools for requested actions. Never claim an action is impossible when a listed tool can perform it.
- Treat tool results as authoritative. Report errors instead of inventing successful output.
- Keep responses concise and point to created files by workspace-relative path.
- Preserve secrets and protected runtime state. Do not expose `.nuaai/`, credentials, tokens, databases, or private keys.

## Capability routing

- Use `workspace.command` for allowlisted CLI work.
- Use workspace file tools for creating, reading, editing, and inspecting files.
- Use `computer_use` for the desktop only when the user explicitly requests GUI interaction.
- Use Matrix attachment tools for inbound and outbound files.
