---
name: workspace-cli
description: Use when reading or searching workspace files or running NUAAI's small read-only host-command set. Report only captured tool results.
license: MIT
compatibility: Requires the NUAAI workspace tools. Commands are allowlisted, shell operators are rejected, child environments are minimal, and protected files remain inaccessible.
metadata:
  author: tylerdotai
  version: "1.0"
  triggers: "workspace file, read file, inspect file, search files, safe command, host identity, disk usage, memory usage, process list, current directory, system version"
allowed-tools: "workspace.list workspace.read workspace.inspect workspace.search workspace.command"
---

# Workspace and Safe Host Inspection

NUAAI workspace tools provide bounded project-file access and a deliberately small read-only command surface. Completed tool results are the only evidence of file or host state.

## Truth contract

1. Prefer `workspace.list`, `workspace.read`, `workspace.inspect`, and `workspace.search` for project files.
2. Use `workspace.command` only for an executable in the documented allowlist.
3. Issue one command at a time with arguments in the separate `args` array.
4. Preserve nonzero exit codes, stderr, timeouts, empty output, and permission failures.
5. Protected runtime state, Git metadata, credentials, databases, tokens, key material, and environment files are unavailable. Report the protection instead of trying another path or command.
6. Never claim a command ran without a completed tool result.

## Command boundary

The exact v1 command set is:

```text
cat date df echo free head printf ps pwd stat tail uname uptime wc which whoami
```

The boundary rejects path-qualified executables, arbitrary shell, `sudo`, deletion, pipes, redirects, chaining, interpreter evaluation, VCS/provider/package-manager CLIs, credential-like paths, and outside-workspace file operands. `ps` supports only safe process identity/state columns.

## Common recipes

```text
workspace.command { "command": "pwd", "args": [] }
workspace.command { "command": "ps", "args": ["-e"] }
workspace.command { "command": "uname", "args": ["-a"] }
workspace.command { "command": "df", "args": ["-h"] }
workspace.command { "command": "free", "args": ["-h"] }
workspace.command { "command": "uptime", "args": [] }
```

Use `workspace.read` for ordinary text instead of `cat`. Use `workspace.inspect` for bounded metadata or previews of supported non-text files. Use `workspace.list` instead of invoking an unbounded recursive listing command.

## Unsupported operations

Raw `git`, `gh`, `node`, `npm`, `npx`, `python`, `ollama`, `codex`, `ss`, `ls`, hardware-enumeration tools, and arbitrary scripts are not available through `workspace.command`. Do not show an unsupported command as though the model can run it.

## Verification checklist

- [ ] The selected tool supports the request.
- [ ] The tool completed and returned the reported value.
- [ ] No protected or outside-workspace path was accessed.
- [ ] No unsupported command was silently substituted.
- [ ] Errors and empty results remain visible.
