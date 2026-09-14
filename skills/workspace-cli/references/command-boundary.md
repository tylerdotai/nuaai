# Workspace CLI Boundary Reference

## File tools

- `workspace.list`: non-protected project file listing.
- `workspace.read`: text-file read inside the project boundary.
- `workspace.inspect`: bounded metadata and supported preview.
- `workspace.search`: text search in non-protected project files.

## Command tool

`workspace.command` accepts one bare allowlisted executable and a separate argument array. The exact v1 set is:

```text
cat date df echo free head printf ps pwd stat tail uname uptime wc which whoami
```

The tool rejects shell operators, interpreter evaluation, path-qualified executables, protected runtime/Git/credential paths, outside-workspace file operands, ambient child environments, and commands outside the allowlist. `ps` is limited to safe PID, parent PID, state, and executable-name columns.

Use `workspace.list` instead of a recursive host listing command, `workspace.inspect` instead of a generic file-identification CLI, and dedicated product tools instead of VCS, provider, package-manager, networking, or hardware CLIs.

## Reporting rule

A command intent is not a command result. Report only values present in a completed tool result. Preserve nonzero exit codes, stderr, timeouts, empty output, and protection failures instead of filling gaps from memory.
