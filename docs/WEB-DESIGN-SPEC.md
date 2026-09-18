# NUAAI Web Interface — v1.0 Design Specification

## 1. Design philosophy

NUAAI should feel like a mature conversational work surface, not a developer dashboard. Conversation is the visual center. Each assistant response owns progress, evidence, failure, and actions. Runtime and workspace controls remain available through compact disclosures instead of permanent telemetry panels. The interface uses exact status language, restrained color, and immediate feedback.

The intended emotional result is **controlled, capable, and trustworthy**.

## 2. Product information architecture

### Primary destinations

1. **Conversation** — sessions, threads, transcript, live response, action activity, composer.
2. **Memory** — explicit durable records only. Automatic answer retention is not represented because v1 does not perform it.
3. **Automations** — schedules and durable task outcomes in one surface.
4. **System** — provider health, active provider/model, skills, plugins, and runtime facts.

### Removed duplication

- Skills and Plugins become sections inside System.
- Schedules and Tasks become sections inside Automations.
- Mobile has one three-item bottom navigation bar; Automations remains available in the conversation drawer.
- Provider controls leave the session sidebar.
- Conversation metrics leave the primary reading flow.
- The global activity rail is removed. Run activity is response-local and expandable.

## 3. Visual system

### Color tokens

| Token | Value | Role |
| --- | --- | --- |
| Canvas | `#0B0D10` | Flat app background |
| Surface | `#0F1115` | Conversation and rail ground |
| Surface raised | `#171A20` | Composer and disclosures |
| Surface hover | `#1C2027` | Pointer/focus feedback |
| Border | `#252A33` | Necessary structural separation |
| Border strong | `#343B47` | Focused controls |
| Text | `#F4F5F7` | Primary content |
| Text secondary | `#A9B0BC` | Labels and metadata |
| Text muted | `#747E8C` | Timestamps and tertiary copy |
| Accent | `#7DD3B0` | Connected state and primary action |
| Accent quiet | `#182B25` | Selected rows only |
| Information | `#86A9FF` | Queued/running information |
| Warning | `#F2B46D` | Waiting/degraded state |
| Error | `#FF7B87` | Failed/offline state |

### Typography

- Stack: bundled `Inter Variable`, then `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI"`.
- Monospace: `ui-monospace, "SFMono-Regular", Consolas, monospace`.
- Display: 20–24 px, weight 680, tracking `-0.025em`.
- Section heading: 14–16 px, weight 650.
- Body: 14 px desktop, 15 px mobile, line-height 1.55–1.65.
- Metadata: 11–12 px, medium weight, modest positive tracking.
- No oversized masthead and no decorative marketing typography inside the application shell.

### Component mechanics

- Corners: 8 px controls; 10–12 px panels.
- Borders: 1 px, never decorative.
- Shadows: one soft raised-panel shadow; no glowing cards.
- Primary actions: accent fill, dark text, 120 ms press scale to `0.97`.
- Secondary actions: raised surface + border.
- Motion: transform/opacity only; 120–220 ms custom ease-out.
- Keyboard-triggered navigation: immediate, no animation.
- Hover styling applies only to fine pointers.
- Reduced motion removes translation and scaling.

## 4. Desktop architecture (minimum 1024 px)

### Frame

- Exact viewport shell: `height: 100dvh; overflow: hidden`.
- Header: 58 px.
- Body: `min-height: 0`; no document-level scrolling.
- Left rail: 260 px, session list scrolls independently.
- Center: minimum 0-width conversation workspace.
- Reading and composer column: maximum 54 rem with responsive edge padding.

### Header

- Compact NUAAI mark and “Local agent” label.
- Connection state with exact language: Connected, Reconnecting, Offline.
- Compact connection state, Commands trigger, and refresh action.
- Provider, model, permission, and context controls live in the composer.

### Session rail

- New conversation action at the top.
- Search immediately below New conversation.
- Scrollable sessions grouped as Today, Previous 7 days, and Older.
- Secondary destination navigation at the bottom.
- No provider cards or model buttons in this rail.

### Conversation workspace

- Header contains session title, real thread selector, and thread creation. Permission and model details stay in the composer.
- Transcript owns remaining vertical space and scrolls independently.
- User messages align right in compact tinted bubbles.
- Assistant messages use typography and whitespace rather than a decorative card or left marker.
- Tool records do not render as transcript messages.
- Structured Markdown, code, tables, and links stay within the reading column.
- Each assistant response contains a compact run summary and expandable tool timeline.
- Composer stays visible at the bottom and never participates in transcript scrolling.
- Enter sends; Shift+Enter adds a line; IME composition never submits early.
- Send, Queue, and Stop occupy the same circular action position.
- Follow-ups explicitly choose Send next or Interrupt and send.

## 5. Mobile architecture (below 760 px)

- Exact shell: 390×844 acceptance viewport, `height: 100dvh`, zero horizontal overflow.
- Header: 52 px with menu, NUAAI mark, connection dot, commands.
- Session rail becomes an accessible sheet opened from the header.
- Conversation header is one compact row; long names truncate.
- Transcript and composer share the visible area; composer remains on screen above bottom navigation.
- Bottom navigation has three destinations: Chat, Memory, System.
- The conversation drawer contains search, sessions, Automations, and other secondary destinations.
- Activity remains inside the assistant response; no extra section appears between transcript and composer.
- All tap targets are at least 42 px.
- No duplicated New/Ask/Commands toolbar.

## 6. State model

### Connection

- `connecting` — initial handshake.
- `connected` — authenticated HTTP and Server-Sent Events ready.
- `reconnecting` — SSE connection lost; EventSource reconnects with `Last-Event-ID`.
- `offline` — HTTP load failed or reconnect window exhausted.

### Run projection

Events are filtered by session/thread before pagination and projected by `runId`, never concatenated globally.

- `run.created` / `run.queued` → queued.
- `run.started` / `model.started` → running.
- `tool.started` → action.
- `tool.completed` → running with completed action record.
- `run.completed` → completed and live delta buffer cleared.
- `run.failed` → failed and live delta buffer cleared.
- `run.cancelled` → cancelled and live delta buffer cleared.

The versioned `ThreadPresentation` DTO is authoritative for durable messages, run ownership, status, activity, errors, and safe artifact fallbacks. Stable synthetic response IDs prevent live/final duplication. Live deltas render only for a non-terminal run.

## 7. Empty, loading, and failure states

- No sessions: primary “Start a conversation” action plus one-sentence explanation.
- Empty conversation: three truthful starter actions; no fabricated activity.
- Loading: quiet skeleton blocks sized to final content.
- Reconnecting: amber connection indicator; composer disabled with reason.
- Offline: contained error panel with Retry and local `nuaai doctor` instruction.
- Failed run: visible terminal state, retained user request, retry/resume action when supported.
- Empty Memory/Automations/System sections: explain what creates records and provide the nearest valid action.

## 8. Accessibility and interaction

- Landmarks: header, navigation, main, complementary activity.
- Destination controls use `role="tablist"`, `role="tab"`, `aria-selected`, and named panels.
- Session selection uses `aria-current`.
- Drawer and command dialog trap focus through native dialog behavior where available and return focus on close.
- Status updates use polite live regions; failures use alert role.
- Focus rings are always visible for keyboard input.
- Color never carries status alone; text labels accompany dots.
- `prefers-reduced-motion`, `prefers-reduced-transparency`, and increased contrast receive deliberate fallbacks.

## 9. Before / after contract

| Before | After | Why |
| --- | --- | --- |
| Oversized brand masthead | Compact 58 px application header | Restores vertical working space |
| Whole document scrolls | Exact viewport shell with independently scrolling regions | Keeps context and composer available |
| Five capability tabs plus duplicate mobile actions | Four task-oriented destinations | Matches user intent instead of implementation nouns |
| First thread is hardcoded | Real thread selection preserved per session | Makes persisted threads usable |
| All model deltas concatenated forever | Per-run projection cleared on terminal events | Prevents duplicate assistant output |
| 50 ms polling for only three seconds | Server-Sent Events lifecycle plus bounded fallback status checks | Supports real long-running work |
| Provider cards inside session navigation | Provider and capability controls inside System | Removes unrelated sidebar clutter |
| Tool messages plus a separate global rail | Response-local summary and expandable timeline | Keeps work attached to the answer that owns it |
| Fixed bottom toolbar overlays mobile content | Bottom navigation reserves layout space | Prevents covered messages and controls |
| Four competing mobile destinations | Three primary destinations plus drawer-based secondary navigation | Protects conversation width and hierarchy |
| Generic “Session N” titles | Date-based “Conversation · time” titles | Removes visible prototype copy |
| “fetch failed” style UI errors | Exact offline/reconnect/retry states | Makes failures actionable |

## 10. Verification gates

1. Pure reducer tests prove terminal events clear live output and cross-run deltas never mix.
2. Typecheck, unit tests, and production web build pass.
3. Playwright creates a session, sends a run, verifies exactly one final assistant message, reloads, switches sessions and threads, visits every destination, creates/triggers an automation, and checks offline/cancel states.
4. Desktop 1440×900 and mobile 390×844 report `scrollWidth === clientWidth`.
5. Composer bounding box remains inside the viewport at both sizes.
6. Browser console and page-error collections are empty.
7. Desktop and mobile screenshots receive visual review before completion.
