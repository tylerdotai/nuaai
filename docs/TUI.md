# NUAAI terminal client

## Action approval modes

Use `/permissions` (also in Settings) to select Manual, Smart or confirmed Unguarded for the current conversation. `/permissions reset` revokes session grants and returns to Manual. The conversation title shows the mode. On a visible action card: **Ctrl-Y** allows once, **Alt-G** grants the displayed scope for this session, **Ctrl-N** denies. Alt-Y remains the identity shortcut. Smart may use additional provider requests for uncertain actions; hard permission/path/availability boundaries remain independent of approval mode. See [native tools and approval contracts](TOOLS_AND_APPROVALS.md) for exact scope, persistence, trash recovery and the Hermes/Codex/Pi audit.

The terminal client is a conversation-first client of the same authenticated daemon used by the web application. It does not run a separate agent loop.

## Start in a contained project directory

```sh
nuaai tui
```

The CLI selects the runtime under the home directory, not a directory-local database. The launch directory is the new session's project workspace and must be physically inside the selected runtime root. For an explicitly separate runtime:

```sh
NUAAI_ROOT=/absolute/runtime/root nuaai tui
```

Use the same root when initializing or starting that daemon. Existing checkout-local state is not automatically moved or merged into the home runtime.

```sh
nuaai init
nuaai daemon
# From another terminal, inside a project contained by the selected root:
nuaai tui
```

`nuaai doctor` reports the selected model and provider health. If the CLI points at the wrong daemon, check `NUAAI_ROOT`; do not create another database just to make a directory-dependent launch work.

## Instruction sources and refresh

Every new session captures global and project `SOUL.md`/`AGENTS.md`; the header shows a compact identity revision/status summary. `/identity` (Alt-Y, or Instruction sources in the command menu/settings) shows source scopes, statuses, byte counts, capture time and workspace, never private instruction text. `/identity refresh` opens a confirmation bound to that exact selected session. Reloading creates a new revision for future runs without changing admitted runs or discarding the draft.

File edits affect new sessions immediately; reconnects and daemon restarts keep existing snapshots. New conversation retains the selected project workspace, and recovery state is separated by daemon **and launch workspace**. Out-of-root launches are rejected, not silently redirected. See [session instruction identity](SESSION_IDENTITY.md) for precedence, containment, compatibility and inheritance.

## Switch to Codex

Inside the TUI:

1. Enter `/provider codex`.
2. Type part of a model name to filter the live catalog.
3. Select with arrow keys and Enter.

Alternatively, `/model` or Ctrl-P searches models across configured providers, and `/model <exact-model-id>` selects an unambiguous available model. Unavailable providers are displayed with their health detail rather than silently selected. The daemon persists provider and model selection; Escape keeps the existing selection. Codex authentication and model discovery still come from the installed Codex CLI, not a separate terminal-client credential store.

## Keyboard-first controls

Use **Ctrl-G**, **Alt-P**, or **Alt-H** to open the searchable command palette and keyboard reference. Search by action, command, or chord (for example `model`, `new`, or `Ctrl-N`). Command rows execute with Enter; key-reference rows are informational. Slash-command suggestions show the same shortcut hints.

| Action | Shortcut |
| --- | --- |
| New conversation | Ctrl-N; Alt-N explicitly creates one even with approvals pending |
| New thread | Ctrl-T |
| Find conversations / threads | Ctrl-F / Alt-T |
| Choose model | Ctrl-P or Alt-M; Ctrl-M with distinct modified-key reporting |
| Choose provider | Ctrl-O |
| Commands and shortcut help | Ctrl-G, Alt-P, Alt-H |
| Settings / live runtime status | Alt-S / Alt-U |
| Focus approval cards | Alt-A |
| Background tasks / automations | Alt-B / Alt-C |
| Find memories | Alt-F |
| Skills / trusted plugins | Alt-I / Alt-L |
| Toggle tool details / compact spacing | Alt-D / Alt-K |
| Refresh daemon state | Ctrl-R |
| Cancel current run | Ctrl-X |
| Review interrupted run for resume | Alt-R |
| Exit client, leave daemon running | Ctrl-C |

**Context wins:** Ctrl-N denies the selected visible approval instead of creating a conversation. While that conversation has a pending approval hidden behind a menu, Ctrl-N is blocked: Escape back to the action card first. Ctrl-Y only approves a visible card, bound to its exact payload. New conversation does not cancel a run in another conversation. No shortcut deletes records or bypasses a confirmation.

Shortcuts can switch directly between pickers and preserve the unsent draft and cursor. New conversation/thread shortcuts carry the unsent draft into the new conversation/thread. Escape from a picker restores the draft; Escape in the conversation clears it. Automation forms keep their own keys so shortcuts cannot discard partially entered fields. Appearance toggles save the same preferences as Settings.

**Terminal compatibility:** conventional terminals send Ctrl-M and Enter as the same carriage-return byte. That byte always sends the message; NUAAI only treats Ctrl-M as model selection when the terminal reports a distinct modified-key event (CSI-u/Kitty). Ctrl-P and Alt-M are portable alternatives. Alt chords can also be entered as Escape, then the letter; some terminals/window managers reserve Alt combinations, so change those terminal bindings if needed. Tab, Backspace, multiline input, and Ctrl-A/E/U/K editing remain unchanged. The current Ink input API does not expose F1 separately, so shortcut help uses Alt-H rather than an unreliable function-key binding.

## Conversation and input

- `/new [title]`, `/sessions`: create or search conversations.
- `/thread [title]`, `/threads`: create or search threads in the selected conversation.
- `/rename [title]`, `/rename-thread [title]`: rename the selected record.
- `/delete`, `/delete-thread`: review the exact target before permanent deletion.
- Enter sends; Alt-Enter inserts a newline. Large drafts wrap into a cursor-following editor.
- Left/Right move the cursor. Ctrl-A/E jump to the beginning/end; Ctrl-U/K erase before/after the cursor.
- Alt-Up/Down recall sent inputs for a single-line draft. Plain Up/Down scroll the transcript for single-line drafts and move between lines for multiline drafts.
- PgUp/PgDn scroll rendered transcript rows, including within a single long reply.
- `/cancel` or Ctrl-X requests cancellation; `/resume` asks for explicit confirmation before resuming an interrupted run.

Replies render common Markdown headings, emphasis, links, quotes, and fenced code. Unsupported Markdown remains readable literal text. Artifacts and citations appear as labeled links; terminal output cannot render every browser artifact inline.

## Draft recovery, search, files, and outputs

Draft text, cursor, sent-input history, pending attachment bytes, and the selected session/thread are stored per thread in an owner-only `.nuaai/tui-drafts-<daemon-key>.json` file. The daemon URL and launch workspace separate recovery files for different runtime/project contexts. Changes are debounced and flushed when the client exits normally. A corrupt recovery file stays untouched and produces a persistent warning rather than being silently replaced. Additional submission or request errors appear alongside that warning. New runs are blocked when the submission identity cannot be saved; the draft remains visible and no run is submitted. Switching to an existing thread restores its draft; creating a new conversation/thread by shortcut carries the current unsent draft.

| Workflow | Keys / commands |
| --- | --- |
| Search the entire selected conversation | Alt-Z or `/search [text]` |
| Next / previous matching turn | Alt-J / Alt-V |
| Browse local files | Alt-W or `/attach` |
| Attach an exact local path | `/attach <path>`; Tab opens completions for a partial path |
| Inspect/remove pending attachments | Alt-E or `/attachments`; Enter removes the selected pending file |
| Response/code copy and artifact open/save | Alt-O or `/outputs` |
| Export all conversation turns | Alt-X or `/export [destination path]` |

Search loads older history before filtering, then Enter jumps to the matching rendered turn. Matching is case-insensitive and turn-based; next/previous wraps through matching turns. Ctrl-F remains the session finder. Search and output menus preserve the draft.

Local file paths can contain spaces and may be absolute, relative to the launch directory, or start with `~/`. Attachments use the existing authenticated run-submission contract, not a separate upload store. The shared limits are **4 files / 512 KiB total**, with supported UTF-8 text/source formats and PNG/JPEG/WebP. Pending files are snapshotted when attached, persist across restart, and clear only after confirmed run acceptance. Failed or uncertain submissions retain the files and retry identity; changing attachments creates a distinct submission. With only attachments pending, Enter submits them as `Attached files`.

The outputs menu lists assistant responses and artifacts across the entire conversation. Response actions offer the full answer and individual fenced code blocks. Clipboard actions emit an **OSC52 request**: the terminal must allow/support clipboard writes; NUAAI reports a request, not a guaranteed clipboard update. Copy is capped at 100 KiB; export larger content instead.

Artifact saves use authenticated same-daemon download routes, reject redirects, cap downloads at 32 MiB, and create new owner-only files without overwriting. Exports include all paginated conversation turns and artifact/citation links in Markdown. Default saves live under the runtime root's `.nuaai/exports/`; save notices show paths relative to that root. `/export <path>` selects a destination but still refuses an existing file. Open uses the system viewer/browser with an argument array, never a shell; only HTTP(S) links and absolute saved paths with supported viewer extensions are admitted. Executable and active document types such as scripts, `.desktop`, and HTML remain saved files for deliberate manual handling rather than automatic execution.

## Skill retrieval and creation

- `/skills` lists skills and toggles enabled state; Enter on a listed skill toggles it.
- `/skill <name>` reads full enabled skill instructions without executing scripts.
- `/skill-create <name>|<instructions>` explicitly saves an instruction-only skill in the runtime private library. Names are lowercase slug segments, at most 64 characters; collisions create suffixed names.
- The model has typed `skill.list`, `skill.search`, `skill.load`, and approval-governed `skill.create` tools, plus `memory.search`, `memory.store`, and `memory.forget`. Read-only profiles cannot create skills or memories.
- Expected model-side skill unavailability returns `loaded: false` with a reason (`not_found`, `disabled`, or `missing_tools`) and no instructions. This is a completed availability lookup, not proof that a skill loaded or an action ran. Unexpected loading errors and actual action failures remain errors.
- Select a task in `/tasks` to read the recorded failure, linked run ID, correlation ID and linkage provenance. PgUp/PgDn scroll the details. The read-only `task.inspect` agent tool uses the same authenticated diagnostic projection; it does not rerun the task or expose its prompt/context. Legacy links are recovered only from a unique exact task-session match; ambiguity is reported.
- Disabled/unconfigured external-agent, MCP, and computer execution are omitted from the model tool catalog; diagnostic/status calls remain available.

## Command recovery and responsiveness

- A failed typed slash command retains its original input only if that input has not since been edited or moved to another thread. Writes are never automatically retried; after a lost response, check saved state before deliberately retrying.
- Memory, task, schedule, approval, skill and model commands wait for their own required catalog response, not unrelated background health/catalog requests. Late superseded catalog results cannot replace current state.
- `/refresh` reports success only when the conversation refresh succeeds. Connection/snapshot failures remain visible and the failed command can be retried.
- Unconfirmed run submissions keep a hash-keyed idempotency UUID in the private draft document. It is flushed before admission and survives a client restart; confirmed acceptance retires it with the submitted input. If that private state cannot be saved, the TUI does not submit the run.

## Runtime controls

- `/settings`: choose model/provider, save compact transcript spacing or expanded tool activity, and manage skills/trusted plugins.
- `/status`: read live daemon counts, provider health, active model, context budget, and client permission profile.
- `/memory`: search and inspect memories; deletion requires a second confirmation. `/remember <text>` adds one.
- `/tasks`: inspect tasks and confirm cancellation of eligible tasks.
- `/schedules`: inspect automations, pause/resume, edit, confirm an immediate run, or confirm deletion.
- `/schedule`: guided name/type/expression/instructions form, then a final review. Ctrl-B returns to the previous field; Escape cancels. Editing an existing automation preserves its enabled/paused state.
- Pending approvals appear inline in their conversation turn with the action preview. Ctrl-Y approves the selected exact action once; Ctrl-N denies it. Tab cycles requests when the draft is empty. `/approvals` focuses the chat card; it does not open a menu. Merely displaying a card or pressing Enter does not approve it.
- Tool activity stays inside its assistant turn, before the authoritative answer. Failed calls show the actual error; expanded successful details are controlled by `/settings`.

Pickers are searchable and terminal-height bounded. PgUp/PgDn scroll long detail panes. Unknown slash commands return an error instead of becoming model prompts. `/help` lists current commands; `/refresh` reloads daemon state.

Escape dismisses the current interaction. `/quit` or Ctrl-C exits the terminal client without stopping the daemon.
