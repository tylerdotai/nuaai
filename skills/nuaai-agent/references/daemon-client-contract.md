# NUAAI daemon and client contract

## Startup

The built launcher is the supported production-shaped local entrypoint:

```bash
set -a
. ./.nuaai/matrix.env
set +a
npm start
```

The Matrix environment file is private runtime state and must remain mode `0600`. Never print the access token or include the file in logs, commits, screenshots, or bug reports.

Required Matrix values:

- `NUAAI_MATRIX_ACCESS_TOKEN`
- `NUAAI_MATRIX_USER_ID`
- `NUAAI_MATRIX_HOMESERVER_URL`

The daemon also requires both `features.matrix` and `matrix.enabled` to be true in `.nuaai/config.json`.

## Client boundary

Web, TUI, CLI, Matrix, and Element are clients of one daemon. The daemon owns:

- durable sessions and threads;
- provider/model selection;
- permission filtering;
- tool execution;
- memory and schedules;
- Matrix sync, typing, reactions, media, and replies.

A client-side success message is not evidence of a completed run. Verify the daemon run status and persisted event before reporting completion.

## Health and authentication checks

Run the dependency-free verifier from the repository root:

```bash
node skills/nuaai-agent/scripts/verify-daemon.mjs
```

Expected results:

- `/health` returns HTTP `200` with `ok: true` and `daemon: true`;
- `/api/status` without credentials returns HTTP `401`.

## Matrix troubleshooting

1. Check the live log for `NUAAI daemon listening`.
2. Check for `Matrix integration disabled`; this means a flag, user ID, or access token was missing at process startup.
3. Confirm the daemon process inherited the Matrix environment without printing values:
   ```bash
   tr '\0' '\n' </proc/<daemon-pid>/environ | grep -E '^NUAAI_MATRIX_(ACCESS_TOKEN|USER_ID|HOMESERVER_URL)='
   ```
4. Confirm the daemon log contains `[Matrix] received` after a message arrives in Element.
5. Confirm a terminal `[Matrix] run=... status=completed|failed|cancelled` line.
6. If Qwen3.8 is active, allow bounded first-response latency; a loaded 27B local model can take about a minute to answer. A running persisted run is not a transport failure.

The absence of an outbound response after a completed run is a Matrix send-path failure and must be investigated separately from provider latency.

## Thread identity

Matrix main-room messages and Element thread replies resolve to stable source keys. Outbound responses preserve the originating `m.thread` relation when an inbound event is threaded. Do not create a new session for every message.
