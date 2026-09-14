---
name: mcp
description: Use when the user asks to inspect MCP servers, discover MCP tools, check MCP connectivity, or execute a configured MCP tool. Use the authenticated MCP boundary and report configured or failed state exactly.
license: MIT
compatibility: Requires the NUAAI MCP manager and a configured authenticated server. No configured server means no MCP execution is available.
metadata:
  author: tylerdotai
  version: "1.0"
  triggers: "MCP, mcp server, mcp tool, discover tools, connected servers, integration server, tool server"
allowed-tools: "mcp.status mcp.discover mcp.execute computer.status computer.use"
---

# MCP Operations

1. Call `mcp.status` before claiming a server or tool is connected.
2. Call `mcp.discover` to obtain the current permission-filtered tool names and schemas.
3. Execute only a discovered tool through `mcp.execute` with the exact name and arguments.
4. Use `computer.status` and `computer.use` for the dedicated computer boundary rather than guessing MCP names.
5. If no server is configured, say MCP is unconfigured. Do not invent integrations.
6. Preserve authentication, permission, timeout, and tool errors.

See [references/mcp-contract.md](references/mcp-contract.md).
