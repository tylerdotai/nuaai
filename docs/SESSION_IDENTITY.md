# Session instruction identity

NUAAI captures `SOUL.md` and `AGENTS.md` **per session**, not once when the daemon starts. Files edited while the daemon is running affect newly created sessions. Existing sessions keep the captured revision until an explicit refresh.

## Roots and precedence

Only these four paths are considered, in ascending prompt order:

1. `<NUAAI_ROOT>/SOUL.md` — global defaults and style.
2. `<NUAAI_ROOT>/AGENTS.md` — global operating rules.
3. `<session workspace>/SOUL.md` — project defaults and style.
4. `<session workspace>/AGENTS.md` — project operating rules.

The prompt explicitly states that project rules refine global defaults, `AGENTS.md` outranks `SOUL.md` within the same scope, and runtime permissions and security boundaries outrank every instruction file. NUAAI enforces source selection and ordering; instruction text does not grant capabilities or bypass approvals. When both roots are the same directory, each file is loaded once and labeled `project`.

`NUAAI_ROOT` selects the daemon/database, not the current project's instructions. The workspace must be an existing directory physically contained in that daemon's root. CLI `run` and the TUI pass the actual launch directory; an out-of-root launch is rejected rather than silently reading another project's instructions. Start the client from a contained project directory or deliberately select a daemon root that contains the project.

There is no parent-directory walk, home-directory fallback, source-key path inference, linked-file expansion, or recursive discovery. The four exact paths are the complete allowlist. Instruction-file symlinks, hard links, non-regular files, invalid UTF-8, and changed-during-read files are not admitted. A workspace symlink escaping the daemon root is rejected. A retained workspace must still resolve to the same contained physical directory when the session is used; replacing it with an escaping symlink does not redirect tools or instruction reads.

## Lifetime and execution

Snapshots live in private SQLite `session_identity_snapshots` rows with a revision, timestamp, origin, workspace, source metadata, and bounded instruction contents. They survive reconnects and daemon restarts. Run admission stores `identitySnapshotId` in the private execution context. Queued, interrupted, resumed, and restart-recovered runs therefore keep the admitted snapshot even if the session is refreshed before execution continues.

Workspace file tools, workspace commands, native skills, and skill indexing resolve against the session's retained workspace, not the daemon launch directory. Existing tool permissions and protected-path rules still apply. `prompt.assembled` diagnostics include the snapshot ID and revision, not instruction contents.

Refreshing creates a new revision for **future admissions only**. It does not rewrite existing snapshots or silently modify an active/queued run. Refresh reads the same authorized roots; it cannot change a session into a different project. No daemon restart is needed for file edits or a refresh.

## Inspect and refresh

All inspect/status actions return metadata only: revision, origin, capture time, workspace, precedence, and source status/size. No file text is returned.

| Client | Inspect | Explicit refresh |
| --- | --- | --- |
| TUI | `/identity`, or Instruction sources in the command menu/settings; a compact summary remains in the conversation header | `/identity refresh` or Refresh instruction sources opens a confirmation bound to the selected session |
| CLI | `nuaai identity <session-id>` | `nuaai identity <session-id> --refresh` |
| Web/PWA | Instruction sources above the conversation, or Commands → Instruction sources on desktop/mobile | Refresh identity → Reload instruction files; the UI reads the exact session back before displaying the revision |
| Matrix | `/identity` in an existing source-bound session | `/identity refresh` |
| Authenticated API | `GET /api/sessions/:sessionId/identity` | `POST /api/sessions/:sessionId/identity/refresh` with an empty JSON object |

`nuaai identity` without an ID selects the CLI session bound to the current launch workspace. It errors if no such session exists; it does not guess another project's latest session. Explicit IDs are preferable in scripts. Status does not create a Matrix session: send a normal message first. File status is not provider output or proof that a model followed every instruction.

## Entry points and inheritance

- **CLI/TUI:** new sessions use the real launch directory. Recovery state is scoped by daemon and launch workspace so restarting in a different project does not silently recover an unrelated selection. TUI New conversation retains the selected session's workspace.
- **Web:** `POST /api/sessions` accepts an explicit `workspaceRoot`; otherwise the daemon root is used. New conversation from a selected session retains that session's workspace. There is no browser-local filesystem/CWD inference.
- **Matrix:** ordinary new sessions use the daemon root. Switching an existing source-authorized session uses its recorded workspace and snapshot.
- **Schedules/background tasks:** runs attached to an existing thread use that session's snapshot/workspace. A task with no session starts a new daemon-root session. Refresh of a session after run admission does not change the queued run.
- **Native subagents:** an explicitly parented native session records `parentSessionId`, copies the parent's current snapshot, retains the same workspace, and records parent snapshot provenance. It does not load newly edited files independently. An explicit child refresh inherits the parent's current revision, not arbitrary child paths. Identity inheritance does not expand tool permissions. External third-party agent processes do not participate in this native snapshot contract.

## Source outcomes and limits

Each exact file is bounded to **12,000 bytes**. A truncated UTF-8 prefix stops before an incomplete code point. Status distinguishes:

- `loaded`: valid nonempty text admitted.
- `missing`: no file exists at the exact allowed path.
- `empty`: the admitted file is empty/whitespace-only.
- `unreadable`: unsafe link/type, read/encoding error, or changing file; only a safe error code is exposed.
- `truncated`: the file exceeds the byte limit; only the bounded valid prefix is admitted.

Status reports admitted bytes and known total bytes. Missing or unreadable files remain visible instead of being described as successfully loaded. A session can continue with the available sources; inspect failures before relying on project rules. Private snapshots and legacy context must not be published or logged. Session list/create responses no longer expose the private `context` field.

## Existing sessions and recovery

A pre-snapshot session with existing opaque `context` keeps a bounded snapshot of that context (`legacy-retained`), without rereading current files and pretending those files governed the original session. Legacy context is bounded to 48,000 bytes and is not injected a second time through the old context field. An explicit refresh replaces the opaque identity with current permitted files. A pre-snapshot session with no context captures the current permitted files on first use (`legacy-captured`); its original historical instructions cannot be reconstructed.

Corrupt stored snapshots produce a generic integrity error rather than silently replacing identity or disclosing parse values. Snapshots from a different root or whose workspace no longer belongs to the daemon are rejected. An old execution context lacking an identity ID pins the session's compatibility snapshot when that run is first recovered. Previously admitted execution contexts with IDs use their recorded IDs, not the latest session revision.

## Verification

`tests/identity.*.test.ts` exercises real temporary daemons, private persistence, provider-boundary system prompts, CLI subprocesses, Ink input, workspace tools, Matrix command transport, background scheduling, and native inheritance. Matrix transport and the provider are controlled fixtures; they are not a claim of live Matrix/provider acceptance.

`tests/e2e/identity.spec.ts` drives the built browser client through authenticated HTTP into the actual daemon/runtime and deterministic provider. The provider rejects the fixture prompt unless both expected project instruction markers are present in its received system prompt. The test covers frozen identity, explicit refresh/readback, project-preserving conversation creation, metadata privacy, and desktop/mobile controls. Installed-package PTY acceptance exercises the shipped Ink client separately.
