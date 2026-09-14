---
name: scheduling
description: Use when the user asks to schedule a future run, create a reminder, run a recurring task, inspect schedules, start a background task, or cancel scheduled work. Use the real scheduler tools and verify returned IDs and states.
license: MIT
compatibility: Requires the NUAAI scheduler/task tools and a permission context allowing the requested mutation.
metadata:
  author: tylerdotai
  version: "1.0"
  triggers: "schedule, scheduled, reminder, remind me, recurring, cron, interval, background task, task, run later, cancel task"
allowed-tools: "schedule.create schedule.list schedule.update schedule.pause schedule.resume schedule.trigger task.create task.list task.cancel"
---

# Scheduling and Background Tasks

- Use `schedule.list` or `task.list` before modifying an existing item.
- For creation, verify the exact name, schedule expression, agent input, timezone assumptions, and enabled state.
- Use `schedule.create` or `task.create`, then report the returned ID and state.
- Use `schedule.update`, `schedule.pause`, `schedule.resume`, `schedule.trigger`, or `task.cancel` only for a verified target.
- Never claim a future run happened merely because a schedule was created; verify the resulting task/run separately.
- Preserve scheduler errors, disabled states, and timeouts.

See [references/scheduler-contract.md](references/scheduler-contract.md).
