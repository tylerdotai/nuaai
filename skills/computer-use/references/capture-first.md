# Computer-Use Reference

## Boundary tools

- `computer.status`: report whether the configured computer server is available and which bounded tools are exposed.
- `computer.use`: perform capture, click, type, key, scroll, drag, or related bounded actions.
- `mcp.status` / `mcp.discover`: inspect the authenticated MCP boundary without exposing credentials.
- `mcp.execute`: execute a discovered tool only when the current permission context authorizes it.

## Capture-first loop

```text
computer.status
computer.use { action: "capture", arguments: { mode: "som" } }
computer.use { action: "click", arguments: { element: <fresh-index> } }
computer.use { action: "capture", arguments: { mode: "som" } }
```

The exact argument shape is the tool schema returned by the current runtime. Never reuse stale element references after a state change.
