# Native tools and action approvals

NUAAI's daemon owns both tool admission and action approvals. A model cannot change an approval mode or grant itself permission. Clients use authenticated session-policy and approval-decision routes.

## TUI controls

- `/permissions` opens the mode picker, shows the current mode and saved session scopes.
- `/permissions manual` prompts for each governed action unless an applicable session scope was explicitly granted. Ordinary read tools do not prompt.
- `/permissions smart` automatically admits bounded local file writing/editing, directory creation, exclusive copying and allowlisted read-oriented commands. Other eligible actions receive a separate, tool-free model assessment using the run's selected provider/model. The reviewer returns allow, deny or ask. Malformed output, provider errors, timeout, unexpected tool calls and oversized proposals fall back to a human prompt. This can incur additional provider usage.
- Destructive operations, external effects and unknown effects still ask a human in Smart mode. They are not silently delegated to the reviewer.
- `/permissions unguarded` requires an explicit confirmation before suppressing action-approval prompts. This does **not** add permissions, disable path protection, expand command allowlists, enable external agents, configure integrations or bypass authentication.
- `/permissions reset` revokes this conversation's grants and returns to Manual.
- Settings includes the approval-mode picker. The conversation title displays the effective mode; unavailable policy readback is shown as unavailable, not guessed to be Manual.

On a visible inline approval card:

| Key | Decision |
| --- | --- |
| Ctrl-Y | Allow this exact action once |
| Alt-G | Allow the displayed session scope and the pending exact action |
| Ctrl-N | Deny |

Alt-G avoids Ctrl-S terminal flow control and preserves the existing Alt-Y identity shortcut. Menus do not authorize hidden action cards. Enter never approves an action card.

Session scopes for `workspace.write`, `workspace.edit` and `workspace.mkdir` bind the tool and resolved file/directory target. A later edit to that same target can change the text. Other actions bind the exact parsed payload. Scopes also bind the workspace and permission source. They apply only inside the owning conversation and persist through daemon restart. New conversations and scheduler-owned sessions do not inherit them. The card shows the scope before a grant; the permissions picker lists grants. Legacy approvals without a recorded scope can still be approved once, but cannot silently acquire a session grant.

Changing modes applies to subsequently proposed actions. Already pending cards still need an explicit decision. A stale automatic-review response cannot override a concurrent mode change. A Smart denial is a recorded terminal failure, not a cue to rephrase or route around the denial.

## Native filesystem lifecycle

Existing tools: `workspace.list`, `workspace.read`, `workspace.inspect`, `workspace.search`, `workspace.write`, `workspace.command`.

Added tools:

| Tool | Contract and readback |
| --- | --- |
| `workspace.edit` | Replace one unique exact text match; refuses missing/ambiguous matches. Read back the result; verifier compares its digest. |
| `workspace.stat` | Check existence, type and size, including absence after trash/move. |
| `workspace.mkdir` | Create a directory and missing parents. Verify directory type with stat. |
| `workspace.copy` | Copy one regular file with exclusive destination creation; never overwrite. Read destination and verify digest. |
| `workspace.move` | Exclusive copy followed by recoverable source trash. Verify destination bytes and source absence. A partial copy/trash failure is reported, not hidden. |
| `workspace.trash` | Trash one regular file, not a directory or symlink. Verify source absence with stat. |

Trash uses the installed `gio trash` implementation with a workspace-owned `XDG_DATA_HOME`, producing Freedesktop `files` and `info` entries under `.nuaai/trash/Trash`. This does not place test fixtures in the operator's personal trash. Missing/failed system trash has no permanent-delete fallback. The private trash store is operator-recoverable, not agent-readable runtime data. There is no automatic purge or permanent-delete tool.

For native workspace file tools, path containment, protected credential/runtime paths, hard-link restrictions and physical symlink checks remain authoritative in every mode. The separately approved host CLI runner is not a workspace jail; subprocesses use the OS account's access. Direct access to known private agent/SSH/cloud credential-store directories is protected rather than merely hidden from listings. Protection is not a substitute for an OS sandbox; it does not prove that every possible secret filename is recognized.

`workspace.command` remains shell-free and read-oriented. The operator-approved `host.command` is a separate general host-account CLI executor. It accepts an exact executable, literal `args`, optional `stdin` and a bounded timeout. There is no implicit shell parsing; an explicitly requested shell/interpreter is itself a host executable requiring the same governance. Output is capped at 256,000 bytes; timeout/cancellation are enforced. Host applications can use normal local account configuration, including Himalaya's own mail-account setup. Provider/API secrets are not added to the child environment.

Host execution is **not workspace-confined**. The pinned project is the working directory, not an OS filesystem sandbox. Native file-tool protection is not a claim that a subprocess cannot reach another path available to the OS account. This boundary was explicitly selected by the operator, rather than silently widening the old command allowlist.

Manual and Smart ask for host invocation approval unless an exact session grant applies. The grant binds executable, argv, stdin and explicit options, as well as workspace/source/session. Different stdin cannot reuse an email-send approval. Confirmed Unguarded skips host invocation approval too; its TUI confirmation states the host-account boundary. Missing executables return actionable discovery errors. Nonzero exit, timeout or output-limit failure stops the run with a possible-side-effect warning instead of automatically retrying a send. There is still no managed background OS-process API.

Example native call: `host.command({"command":"himalaya","args":["--version"]})`. Native subprocess acceptance exercised the actual installed Himalaya binary with this read-only version operation; that check did not send mail. Structured CLI program/stdin bytes are data, not additional user actions or instructions to remove tools. Completion requires the exact successful requested invocation; separate follow-up file effects still require their own evidence.

The acting model can set `requestApproval: true` on an exposed tool call when authorization is uncertain. This forces human review in Manual/Smart, including otherwise routine operations or matching session grants. It cannot approve itself. User-selected Unguarded suppresses that prompt too.

## API and durable diagnostics

- `GET /api/sessions/:id/permissions` reads mode and session scopes.
- `POST /api/sessions/:id/permissions` accepts `mode`, `revokeGrants` and `confirmUnguarded`. Unguarded requires `confirmUnguarded: true`.
- `POST /api/approvals/:id/approve` accepts the exact `payloadHash` and `scope: "once" | "session"` (default once). Invalid scopes fail before a decision.
- Existing denial, expiry, payload-binding and exactly-once execution guards remain in force.
- Schema version 9 adds session policies and opaque approval-scope records. Raw proposed contents are not persisted in these tables.
- `approval.policy.changed` and `approval.policy.decision` events explain policy outcomes. Existing approval and tool lifecycle events retain execution evidence.
- `task.inspect` retrieves recorded child-run causes and correlation. Paused runs include the recorded pause reason, approval ID, pending approval metadata and child-conversation linkage. `/tasks` details offer **Review child conversation**, which opens the action card without granting permission. A background task is a scheduler-owned NUAAI run, not an external-agent adapter. A daemon restart can fail an interrupted scheduler task while its linked durable run remains separately inspectable/recoverable; inspect both states rather than equating the task wrapper with completed child work.

## Reference audit: what each harness actually does

### Hermes

The documented modes are Smart, Manual and Off. Smart uses an auxiliary LLM for risk assessment: low-risk candidates can proceed for that command, dangerous candidates are denied, uncertainty escalates to a person. Hermes also has pre-approval hardline/user-deny rules, protected-file checks and optional isolated execution backends. Off/YOLO does not erase every hard boundary. Therefore copying only a prompt toggle is not parity.

Primary source: <https://hermes-agent.nousresearch.com/docs/user-guide/security>. Installed source inspected: `tools/approval.py`, `tools/approval_smart.py`, `tools/approval_floors.py`. A static inventory of 64 declared native schemas/registrations is retained in the evidence directory; it excludes dynamically supplied MCP, connector and plugin schemas and is not claimed to enumerate every dynamically registered tool.

### Codex

Sandbox permissions and approval policy are separate controls. The official workspace-write/on-request example lets ordinary workspace work proceed while boundary crossings ask. `never` means no approval requests, **not** necessarily unrestricted filesystem access. Full access is a separate sandbox choice. Execution rules compare argument-vector prefixes; compound-command handling is conservative. Narrow rules are not blanket permission for arbitrary interpreters.

Current official documentation also describes a separate automatic reviewer (`approvals_reviewer = "auto_review"`) for eligible interactive approval requests. The main sandbox remains in effect; denials include rationale and anti-circumvention behavior. This is distinct from simply selecting on-request. Specific supported policies depend on the installed version: current docs explicitly retire the old `approval_policy = "untrusted"` setting while retaining project trust concepts. Do not copy an old configuration table blindly.

Primary sources:
- <https://learn.chatgpt.com/docs/agent-approvals-security.md>
- <https://learn.chatgpt.com/docs/sandboxing/auto-review.md>
- <https://developers.openai.com/codex/exec-policy>

NUAAI's active Codex Responses adapter declares a NUAAI-owned tool loop. The older CLI fallback launches Codex read-only with no interactive approval prompts. These adapter details are not evidence that NUAAI has Codex's OS sandbox or every native Codex tool.

### Pi

The installed `@earendil-works/pi-coding-agent` documentation says Pi's tools run with the launching OS account's permissions and do not prompt before every tool call. Project trust controls resource/extension loading, not action confinement. Extensions can intercept `tool_call`, block execution and ask for confirmation. There is no stock Hermes-style approval-mode system to copy as though it were built in. Pi recommends OS/container/VM isolation for containment.

Primary installed sources: `docs/security.md`, `docs/extensions.md`, `README.md` in the installed package. Upstream: <https://github.com/earendil-works/pi>.

### Tool-declaration comparison

The reference-source evidence includes pinned Codex handler/specification files (commit and SHA-256 receipts in `codex-source-references.json` and `codex-tool-declarations.json`), not just marketing documentation. Shell/unified execution, patching, user input, multi-agent control, planning, image viewing and tool-search specifications are distinct handlers. Enabled tool catalogs vary with provider/features; a handler module is not proof of current-session availability.

Pi's installed CLI/settings documentation lists built-in `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find` and `ls`. The ordinary default selection is `read`, `bash`, `edit`, `write`; `codemode` and `tool_search` are additional built-in extension tools rather than the same default set. NUAAI implements the common file lifecycle natively but does not pretend that its restricted command tool equals Bash/PowerShell or that literal text search equals every grep/find option.

## Capability coverage and remaining differences

This is a functional comparison, not a promise that matching tool names imply matching capability.

| Reference capability family | NUAAI status |
| --- | --- |
| File reading, discovery, search and writing | Native existing tools. Not full Hermes document/OCR extraction or Pi glob/grep CLI parity. |
| Exact file patch/edit | Added unique exact replacement. Not arbitrary multi-file patch-language parity. |
| Safe file lifecycle | Added stat/mkdir/copy/move/recoverable trash. Directory tree deletion and permanent deletion intentionally absent. |
| Terminal/code/process execution | Native host-account executable/argv/stdin execution was explicitly approved and added as host.command; workspace.command retains its old read-only allowlist. Managed background OS-process control remains missing. |
| Memory | Native store/search/forget; semantic search depends on embedding availability, with explicit lexical fallback. Not every Hermes memory mutation backend. |
| Skills | Native list/search/load/create; not full Hermes skill-library patch/remove management. |
| Conversation/history | Current-thread run history plus client conversation navigation. Not full cross-session Hermes FTS/history tools. |
| Human interaction | Native exact-action approval cards plus model-requested review flag. Not a general multiple-choice clarification tool. |
| Background work/schedules | Native task/schedule tools and task.inspect. Not OS processes, external-agent adapters or a general multi-agent team. |
| External agents | Dispatcher only when enabled/configured. No fake subagent fallback or silently enabled adapter. |
| Web research | Existing guarded search/fetch/browser-open when configured. Not interactive browser/CDP/vault parity. |
| Desktop | Existing computer integration only when discovered. Hermes desktop-project/preview/pane/terminal-UI tools are host-app-specific and not manufactured as NUAAI capabilities. |
| MCP/plugins | Existing discovery/execution only when available and authorized. Connector account catalogs/authentication are separate integrations. |
| Media | Existing inspection pipeline is not a claim of image/video/music/TTS generation parity. Those require backends and separate configuration/dependency authorization. |
| Social/enterprise-specific tools | Separate integrations, not core filesystem/approval capabilities. No fabricated Feishu, X, YB or messaging-account tools. |
| Planning/task boards | Not added; a tool inventory is not authorization to introduce an unwanted board. |

Full cross-harness tool parity is **not complete**. The audit makes missing capabilities explicit rather than advertising unavailable aliases. This release closes the demonstrated file-lifecycle and installed-CLI execution gaps and adds the requested three approval modes and session grants. Capability-refusal handling requests a relevant diagnostic/execution attempt before rejecting an untested claim; a real read-only profile restriction is reported from the authoritative filtered catalog without alleging that unrelated registered tools prove CLI access.
