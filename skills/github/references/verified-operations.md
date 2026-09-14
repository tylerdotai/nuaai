# Verified GitHub Operations Reference

This reference describes the bounded GitHub operations available to the NUAAI v1 model tool surface. It contains procedures, not current GitHub data.

## Authentication

```text
github.auth {}
```

A successful result may establish authenticated status and the bounded account name. It never authorizes reading or reporting a token.

## Owned repository count

```text
github.repo.list { "mode": "count", "limit": 1000 }
```

Report the returned count and limit. If the result reaches the requested limit, describe it as bounded rather than exhaustive.

## Owned repository rows

```text
github.repo.list { "mode": "rows", "limit": 100 }
```

Report only fields returned by the tool. Repository enumeration covers the selected account's owned repositories; it does not promise every repository visible through organizations or collaborations.

## Unsupported operations

NUAAI v1 does not expose raw `gh`, `git`, or provider CLI execution through `workspace.command`. Individual repository inspection, local Git state, branches, commits, pull requests, issues, Actions, releases, gists, and all GitHub mutations require future dedicated tools.

Never claim an unsupported operation ran. Explicit user authorization permits a supported mutation to proceed; it does not create a missing capability.

## Security boundary

Never request or report credential values. Do not read Git metadata, GitHub credential files, environment variables, or token-bearing URLs. Preserve authentication, network, permission, timeout, malformed-response, and empty-result failures exactly.
