---
name: github
description: Use when checking GitHub authentication or listing repositories in NUAAI. Use dedicated read-only tools and report only verified results.
license: MIT
compatibility: Requires the NUAAI `github.auth` and `github.repo.list` tools plus network permission.
metadata:
  author: tylerdotai
  version: "1.0"
  triggers: "github auth, github authentication, list github repositories, count github repositories, repository list, repo count"
allowed-tools: "github.auth github.repo.list"
---

# GitHub Read-Only Operations

NUAAI v1 exposes two bounded GitHub operations: authentication status and repository enumeration. A skill supplies procedure; only a completed tool result supplies evidence.

## Supported scope

- `github.auth`: verify whether the configured GitHub CLI session is authenticated and return a bounded account name.
- `github.repo.list`: count or list repositories owned by the authenticated account with bounded structured output.

Branches, commits, pull requests, issues, Actions, releases, gists, local Git metadata, and every GitHub mutation are **not exposed by the v1 model tool surface**. Say that the requested operation is unavailable rather than substituting `workspace.command`, inventing output, or asking another tool to run `gh` or `git`.

## Truth contract

1. Use only the dedicated tools named above.
2. Report account names, counts, repository fields, limits, and errors only when present in the completed result.
3. Treat a result at the requested limit as bounded; do not call it exhaustive unless the returned result establishes completeness.
4. Preserve authentication, network, timeout, permission, malformed-response, and empty-result failures.
5. Never expose tokens, credential files, environment variables, or secret values.
6. A model statement such as “I checked” is not proof. The run must contain `tool.started` and `tool.completed` evidence.

## Authentication

Run before repository access:

```text
github.auth {}
```

If authentication fails, report the safe error and stop. Do not inspect credential files.

## Repository count

```text
github.repo.list { "mode": "count", "limit": 1000 }
```

Report the returned count and limit. The operation covers repositories owned by the selected account; it does not promise every repository visible through organizations or collaboration.

## Repository rows

```text
github.repo.list { "mode": "rows", "limit": 100 }
```

Use only returned fields. Do not invent descriptions, visibility, dates, URLs, or repository names.

## Mutations and unsupported reads

The v1 skill cannot create, edit, delete, push, merge, tag, release, rerun workflows, manage secrets, inspect local Git state, or query individual PRs/issues/runs. These requests require a future dedicated, capability-gated tool. Explicit user authorization does not make an unavailable tool available.

## Verification checklist

- [ ] The request is authentication status or owned-repository enumeration.
- [ ] The dedicated tool completed.
- [ ] Every factual GitHub claim appears in the result.
- [ ] Limits, empty results, and failures remain visible.
- [ ] No credential material was requested or exposed.
