# Local subscription voice trial

Use the **reviewed, integrated live-voice build and helper supplied by the operator**.
The UI-only branch is not, by itself, an activated live provider. An unconfigured
installation must still show voice unavailable. No API key, new Codex/ChatGPT login,
credential upload, paid fallback, or automatic microphone capture is required.

## Start and authenticate the preview — operator/Lead only

Do not restart or replace the existing production daemon. Start a separately
owned preview with a new private runtime root and a distinct free loopback port.
Do not copy a production runtime database, auth files, or `.nuaai/` directory.
Keep the existing approved native Codex login environment available only through
the trusted native-host setup; it is not browser configuration.

From the reviewed integration checkout, after its Node/web build and native
helper/source/signaling review, the existing CLI supports this sequence:

```sh
# Lead chooses these paths/port and verifies the reviewed helper; examples are placeholders.
umask 077
export NUAAI_ROOT="/absolute/private/voice-preview-root"
export NUAAI_HOST="127.0.0.1"
export NUAAI_PORT="<distinct-preview-port>"
export NUAAI_VOICE_HELPER="/absolute/path/to/reviewed/nuaai-subscription-voice"
node dist/cli.js init
node dist/cli.js daemon
```

Lead prepares the preview's approved real text provider/integration settings;
headless-test deterministic providers are not a substitute for a user trial.
Do not run onboarding, login, refresh, logout or account-changing commands as
part of this recipe. The trusted helper option is set by the local operator,
never by browser input. Start only the preview process, not a system service.

In a separate operator terminal with the **same** preview root/port, generate a
short-lived pairing link for the browser-visible address:

```sh
NUAAI_ROOT="/absolute/private/voice-preview-root" \
NUAAI_HOST=127.0.0.1 NUAAI_PORT="<distinct-preview-port>" \
node dist/cli.js pair "http://127.0.0.1:<distinct-preview-port>"
```

The output contains a **secret pairing fragment**. Give that link directly to
the intended user through the approved private channel; never paste it into a
report, issue, screenshot, shell transcript or committed file. Open within five
minutes. Pairing exchanges the fragment for an HTTP-only same-site cookie and
removes the token from browser history. An expired browser session requires a
new pairing link, not a Codex account change. Protect the paired browser profile.

The best same-host preview is `http://127.0.0.1:<preview-port>/`: browsers treat
loopback as a secure context for microphone permission. For a browser on another
computer, use an explicitly coordinated SSH forward to the preview loopback
port, then pair for that browser's **local** forwarded URL. Ordinary HTTP to a
LAN/tailnet IP does not permit microphone capture. No new public binding,
Tailscale configuration, host service or production restart is needed.

For an existing `/nuaai/` mount, pair for the complete browser-visible mounted
base URL; do not drop the mount. A fresh root preview normally uses `/`.
The CLI source honors `NUAAI_ROOT`, `NUAAI_HOST` and `NUAAI_PORT`; the daemon owns
both the web assets and authenticated API. A separate Vite-only page is not the
authenticated live application. This document does not claim a particular port
is currently listening: Lead supplies the actual URL after starting the preview.

## User steps — microphone only on your explicit action

1. Open Lead's private pairing link, confirm the dashboard is connected, and
   create/select a conversation and thread. Keep this page visible.
2. Expand **Voice · … · ChatGPT subscription · WebRTC v3**. Availability checking
   does not capture the microphone, start a provider session, or prove quota.
   If unavailable, use **Check voice availability** after the operator resolves
   the visible blocker. Do not try to select an executable, account or endpoint
   in the browser; these are daemon-owned.
3. When ready, click **Start voice** yourself. Only this action requests browser
   microphone access and starts negotiation. Choose the intended microphone and
   allow access if you consent. Nothing should auto-connect after page load,
   pairing, availability checking, reconnect or an earlier failure.
4. Begin with a short harmless phrase such as “Say hello.” Observe microphone,
   transport, remote audio track and playback separately. A connected transport
   or “started in browser” does **not** prove you heard the response. If offered,
   click **Enable audio playback**. Confirm audibility yourself.
5. **Mute microphone** changes only local input. It does not mute response
   playback, cancel a task, or interrupt provider speech. This profile reports
   **speech interruption unsupported** and must not offer an Interrupt speech
   button. Use **Hang up** to stop local playback/capture and end this voice
   session; do not treat it as a verified provider cancellation API.
6. If trying read-only work, request something harmless and inspect the ordinary
   conversation activity. Voice-requested work shows a run ID, task status and
   separate delivery status. Delivery accepted means an SDK write, not audible
   playback. Transcript text alone is not execution evidence. Approve governed
   actions only through the usual controls; voice never grants approval.
7. Finish with **Hang up**. The browser's recording indicator should stop
   (the site's permission grant may remain). Hiding the page, leaving the
   conversation/thread, switching views, closing the panel or page also ends
   foreground voice. These actions do not cancel already admitted durable work;
   use the conversation's explicit cancellation control if that is intended.

## Errors and retry

- **Existing sign-in unavailable/expired:** ask the operator to check the existing
  Codex/ChatGPT sign-in. This UI does not refresh, relogin, switch accounts or
  request credentials. No API-key workaround.
- **Subscription/access:** the existing account must be eligible and have voice
  access; a configured helper is not an entitlement guarantee.
- **Voice quota/rate limit:** wait until access is available, then explicitly
  check availability/start again. There is no automatic retry or paid fallback.
- **Microphone denied/missing/busy:** use browser site/OS audio settings, then
  explicitly start again. Do not grant permission just to check availability.
- **Connection/lease failure:** local media is released; reconnect requires a
  new explicit Start voice action. A stop not confirmed by the daemon is shown
  honestly; local media can already be stopped while the bounded lease expires.

Report only the visible sanitized error, whether you heard audio, and which
status stopped progressing. Never attach raw SDP, ICE/network payloads, bearer
headers, full pairing links, credential files, private database contents or
unredacted helper stderr. Lead shuts down only the owned preview afterward.
