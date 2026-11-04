# AgentBridge live VS Code relay

Independent HTTPS host compatible with the existing Android pairing, device, conversation event replay, voice and WebSocket protocol. Requires Node.js 24+ and the UI adapter's Windows/VS Code prerequisites.

Validation includes successful live phone-to-VS-Code text submission and response delivery, table capture, and hold-to-record voice transcription with the existing Android app. The follow-active-chat update passes typechecking, build, and all 30 automated tests, including native transcript-change guards and sequential requests to different sessions. Read-only live inspection also passed; switching sessions between actual phone requests still needs an end-to-end check. UI automation remains experimental; do not submit self-messages while the live session is running.

## Setup

From the repository's `hostUi` folder:

```powershell
npm install
npm run typecheck
npm test
npm run build
```

Provide a new TLS certificate/key in `certs\host.crt` and `certs\host.key` (or set the paths below). Its SAN must match the private address used by Android; trust its issuing CA using the Android application's existing setup. Do not copy original host credentials or databases. Check the selected chat as described below, run `npm run pair` locally for a five-minute single-use code, then `npm start`. Pair Android against `https://<private-address>:8444`.

Review `.env.example` and copy it to `.env` yourself if desired; no actual environment file is generated. It includes commented `..\host\certs\host.crt` / `..\host\certs\host.key` paths for intentional reuse of the TLS identity only, never host tokens/environment/database. Use the same APK with a **new pairing** for this independent host.

Configuration is read from this package's `.env` or environment:

| Variable | Default |
| --- | --- |
| `HOST_UI_BIND` | `127.0.0.1`; concrete private/loopback IP only |
| `HOST_UI_PORT` | `8444` |
| `HOST_UI_TLS_CERT_PATH` | `.\certs\host.crt` |
| `HOST_UI_TLS_KEY_PATH` | `.\certs\host.key` |
| `HOST_UI_DATA_DIR` | `.\.data` (independent `agentbridge-ui.sqlite`) |
| `UI_TARGET_FILE` | `.\.data\ui-target.json` (optional explicit window binding) |
| `HOST_UI_OPENAI_API_KEY` | unset; voice disabled |
| `HOST_UI_OPENAI_STT_MODEL` | `gpt-4o-mini-transcribe` |
| `HOST_UI_OPENAI_TTS_MODEL` | `tts-1` |
| `HOST_UI_OPENAI_SUMMARY_MODEL` | `gpt-4o-mini` |

Only the explicitly supplied `HOST_UI_OPENAI_API_KEY` enables outbound OpenAI voice requests. Existing host/GitHub credentials are not inherited automatically; an OpenAI voice key may be explicitly reused with the operator's approval. Keep private-network firewall access limited to trusted devices; any paired device can see relay events and revoke devices.

The authenticated `POST /api/voice/summary` route accepts `{ "text": "..." }` (up to 20,000 characters) and returns `{ "text": "..." }`. It uses the configured OpenAI key and chat-completions model to produce a plain-text spoken summary, ideally one or two sentences and no more than 60 words, while preserving critical warnings and uncertainty. Source text is treated as untrusted data; it is not an instruction to follow, and the summary must not claim operations were performed. The summary feature is separate from detailed chat responses. Missing keys return 503; invalid input returns 400 and provider/output errors return explicit 5xx responses without falling back to another model.

### Voice upload returns 503

The Android hold-to-record action uploads audio to `POST /api/voice/transcribe`.
If `HOST_UI_OPENAI_API_KEY` is unset, this endpoint returns 503 with
`Host transcription is not configured`; the existing Android client displays
`Voice upload failed (503)`.

Explicitly configure `HOST_UI_OPENAI_API_KEY` in this package's local `.env`,
then restart the server. With the operator's approval, the same OpenAI key used
by the original host can be supplied under this new variable name; it is not
inherited automatically. Do not paste keys into chat, source files, or shared
logs. Audio is sent outbound to OpenAI for transcription; the resulting text
uses the existing live VS Code relay. No new APK or pairing is required.

## Binding the VS Code window and following its active chat

Run the relay under the same Windows account and non-elevated interactive desktop as VS Code, not as a Windows service. The desktop must remain unlocked. Enable `"editor.accessibilitySupport": "on"` in VS Code settings. This setting was enabled with the operator's approval during initial setup.

Open the intended chat in VS Code, then run:

```powershell
npm run ui:inspect
# Optional: save automatic window selection (also clears an explicit pin):
npm run ui:bind
# Optional: enters a verified multiline Unicode draft, then clears it, without sending:
npm run ui:probe
```

By default, the relay selects the first matching VS Code window in Windows desktop enumeration order and uses its currently visible chat. No binding file is required, and older bindings without an explicit selection mode no longer pin a process. `npm run ui:bind` checks that selection and saves automatic mode. Restarting VS Code does not require rebinding in automatic mode.

To explicitly pin a window instead, use `npm run ui:bind -- --pid <VS-Code-window-process-id>`, then restart the relay. Only this explicit mode pins the process/start time and requires rebinding after that window restarts. Run `npm run ui:bind` without `--pid` and restart the relay to return to automatic selection.

The Agent Sessions sidebar does not need to be open or expose a selected row. Keep the intended chat visible in the selected window. If multiple transcripts are visible, the chat containing keyboard focus is preferred; otherwise the first visible transcript is used. Its accessible Chat Input must be available. Switching chats between completed requests requires neither rebinding nor a relay restart. Run from a non-administrator terminal under the same Windows account as VS Code.

The adapter requests Electron's accessibility tree through the standard Windows accessibility API. It focuses only the active **Chat Input**, types literal Unicode characters using Windows `SendInput`, verifies the exact draft, then invokes the uniquely identified, scoped **Send** button without depending on its icon class. It checks the baseline transcript before typing and again before sending so a chat change cannot silently redirect a request. If no such button is exposed, it presses Enter only when that exact focused editor explicitly advertises **Press Enter to send**. Ambiguous buttons are rejected. It does not use the clipboard, screen coordinates, a remote-debugging port, or arbitrary keyboard-command execution. Do not type or move focus during submission. Existing drafts, pressed modifier keys, busy chats, changed targets, and failed readback cause explicit errors rather than blind retries. Messages support ordinary text and newlines; other control characters such as tabs are rejected.

Assistant text is captured from rendered chat Markdown controls, excluding terminal/tool output. It is a text representation, not full-fidelity Markdown/HTML: some rich formatting and paragraph boundaries may be lost. VS Code updates can change these accessibility controls and require adapter changes.

The existing Android APK needs no changes. Unpair locally in the app, enter this server's new HTTPS address, and pair with its new one-use code. This clears the phone's original cache, not the original host's stored conversations. For example, intentionally reusing the existing TLS paths and setting `HOST_UI_BIND=192.168.1.50` makes the new address `https://192.168.1.50:8444`; ensure Windows Firewall allows that port only on the intended private network.

## Separate phone conversations, following the active chat

The Android **+** button creates a new, empty phone conversation titled **Live VS Code**, with its own ID and persisted event history. It does not open, reset, or switch the VS Code chat. Each phone request uses whichever chat is open in the selected VS Code window, and its reply is stored in the phone conversation that sent the request, even if a different phone conversation is selected before completion. Switching VS Code sessions between requests does not split the selected phone history. Only one remote request may run at a time across all phone conversations.

The underlying VS Code sessions keep their own context: phone history is not copied into a newly selected session, and a new phone conversation does not clear VS Code context. Deleting a phone conversation clears only its relay events/cache and **never deletes or resets a VS Code session**. Existing phone conversations are preserved by this update. Previous local history and unrelated local replies are not imported. Switch VS Code sessions only between completed requests; do not send local messages while a remote response is running.

The relay snapshots message identities before each submission, verifies a new user message exactly matches submitted text, and imports only new assistant messages after that boundary. It requires nonempty completed output as described below; mismatched targets, ambiguous identities, competing input, blocks, failures and deadlines persist an `error` event for replay. Native transcript identity uses the chat control's runtime identity and continuity of visible message IDs, not a supported VS Code session API. A different control or loss of all row continuity is treated as a changed chat; switching chats during capture fails closed. Large virtualization jumps can also cause this conservative failure. A timeout or post-submission failure does not prove VS Code stopped: inspect locally, complete/cancel pending work, then restart the relay before retrying. Further sends after ambiguous submissions or deadlines are rejected to prevent overlapping unknown work.

When the adapter exposes assistant `completed` markers, every captured response must explicitly report `completed: true`; idle timing alone cannot override an unfinished response. Explicitly completed nonempty replies finish as soon as the chat is idle, without an additional settling delay. Adapters without completion markers use the conservative stable-idle fallback. The adapter captures both Markdown responses and plain-text short replies, including accessible table cells reconstructed as Markdown tables, never tool output or UI controls. Restart the host after native adapter changes; already cached replies are not recaptured.

Virtualized transcripts may remove older visible rows. Once a new assistant row has been observed after the verified user boundary, the relay tracks that row by stable ID even if the user row disappears. Unseen assistant rows appearing only after the boundary disappears are not imported; an unverified or incomplete response fails rather than guessing.

VS Code may briefly expose incomplete transcript row identities while updating its accessibility tree. The native adapter validates identities before updating tracking state and retries read-only capture up to three times with a fresh context. Persistent missing or duplicate identities fail explicitly; submissions are never automatically retried. Native errors include the worker line number to aid diagnosis.

Approvals, questions, sign-in, tool confirmations and other unsupported interactions **remain local in VS Code**. The relay never approves them. Remote approval/question packets return an explicit error. Messages are serialized globally; busy targets are rejected rather than queued.

HTTP API uses bearer tokens. WebSocket `/api/ws` requires an initial `{ "type": "auth", "token": "..." }` within five seconds, then the existing `message.create` packets. Device revocation closes connected sockets. Pairing is limited to eight attempts per IP per five minutes; WebSocket payloads are capped at 128 KiB and 60 packets/minute/connection. Request bodies and voice uploads retain original host limits.
