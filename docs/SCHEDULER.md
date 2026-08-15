# Scheduler and Background Agents

Schedules are durable SQLite records and execute through the same `AgentRuntime` used by interactive runs.

Supported schedule types:

- `once` — epoch-millisecond timestamp
- `interval` — integer plus `ms`, `s`, `m`, `h`, or `d`
- `cron` — five-field minute/hour/day/month/weekday expressions
- `manual` — API-triggered execution
- `startup` — execution eligible when the scheduler starts

The authenticated HTTP API supports create, list, update, pause, resume, and manual trigger routes under `/api/schedules`.

Each trigger persists a task record and task lifecycle events. A per-schedule running-count guard enforces `policy.concurrencyLimit` within the daemon. `policy.maxAttempts` enables bounded retries with exponential backoff from `policy.retryDelayMs`; retry attempts and last errors remain in the durable task payload. `policy.missedRun` accepts `run_once` (default) or `skip` for overdue schedules.

The authenticated HTTP API supports create, list, update, pause, resume, and manual trigger routes under `/api/schedules`, plus task inspection and cancellation through `GET /api/tasks` and `POST /api/tasks/:id/cancel`.

On restart, queued/running task records are marked failed with `Task interrupted by daemon restart`; enabled schedules are made eligible for the next poll so work is not silently lost. The daemon-wide filesystem lock prevents a second scheduler process from claiming the same workspace, and cancelling a running scheduled task propagates to its associated agent run. Distributed multi-host ownership is intentionally not supported.
