# Agent continuity checkpoint — work in progress

This is a reviewable source checkpoint, not a finished release or deployment. It is based on `88e7919`; newer main-branch UI, SSE transport and test-infrastructure changes require deliberate integration. Do not replace those changes wholesale with this branch. The working source used for this checkpoint passed check/typecheck and 649 tests in 159 files before publication-specific validation; the PR records the candidate's actual results separately.

## Implemented source

- Pinned session/workspace identity and permission-limited child execution; governed literal host CLI execution, approval controls and durable task diagnostics.
- TUI navigation, editor/forms, chronological activity, feed scrolling/reading-anchor and persistent-menu work, plus authenticated client/attachment improvements.
- Bounded workspace discovery/search, active context compaction/checkpoints, bound-run introspection and archived observation retrieval.
- Selective scoped learning with automatic/manual/off modes, provenance/history/undo, restart persistence and negative controls for quoted/code/introduced-draft material.
- Typed tool-input recovery, actual-outcome repetition guards, uncertain-effect fencing and noncooperative model/tool deadlines.
- Durable parent task outcomes including original failure and partial artifact evidence; first bounded automatic continuation and cancellation fencing.
- Explicit finite continuous-work policy, inherited family admission allowance/deadline, deadline enforcement and truthful budget exhaustion. Controlled tests advance beyond the previous one-hour ceiling under a 24-hour objective; this is **not a real 24-hour soak**.
- Selected **Transfer** brand vectors under `assets/brand/transfer/`. These are original path-based SVG studies, not integrated app branding or trademark clearance.

## Still incomplete

- Sustained safe turn/tool/time-budget checkpoint slices, cross-slice verification/repetition/uncertainty, whole-child-goal waiting, depth/global resource limits, superseding-intent and eligible restart boundaries.
- Owned asynchronous long-running host jobs with durable logs/status/cancel and crash/uncertain-effect handling.
- Web/TUI/CLI long-work controls and cohesive end-to-end goal/task/approval/error state, full installed scrolling and browser/terminal/release acceptance.
- Conversation-first web redesign, compact and genuinely cited sources, final Transfer integration, labels/icons/spacing and responsive visual acceptance.
- Fair dispatch/backpressure, isolated worker lease/submission contracts, controlled 1,000-assignment capacity evidence and reproducible evaluations. **No claim of 1,000 simultaneous production workers.**
- Current-main integration and final release checks. Do not merge or activate based only on the checkpoint's passing source tests.

## Architecture direction

Default to one main reasoning loop per objective with progressively loaded skills/tools. Use subagents when independent parallel work, verification or measured context/tool-selection/isolation needs justify the handoff. Keep validation, approvals, budgets, durable ownership and resource limits in code. Compare architectural changes using shared end-to-end outcomes, individual regressions, latency and actual usage—not agent counts or aggregate scores alone.

Reference: [Building agents: when to fold subagents into your main agent loop](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop). Vendor-reported performance is not this project's measured acceptance evidence.

No live provider campaign, day-long workload, production restart, approval-policy change, or deployment is implied by publishing this branch. Private runtime data, local reports, screenshots, handoff records and unrelated local agent tooling are deliberately excluded.
