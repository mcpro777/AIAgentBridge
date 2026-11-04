# AgentBridge for Android

Native Kotlin/Jetpack Compose client for connecting a phone to an AgentBridge host on a private LAN or VPN. The app does not provide a relay or public ingress. Network requests use OkHttp's standard TLS certificate and hostname validation; the app does not install a custom trust manager or accept cleartext traffic.

## Build

Open this `android` directory in Android Studio (JDK 17 and Android SDK platform 35), or run `gradle :app:assembleDebug` if Gradle is installed. No wrapper is included. Minimum Android version is API 26.

## Connect

Open **Settings** (gear icon) and choose **Live VS Code** or **Copilot API**. Each mode remembers its own HTTPS URL, Keystore-encrypted pairing, selected conversation and Room history. Live VS Code normally uses port 8444; Copilot API normally uses 8443. Pair each mode once using its host's one-time code. Switching modes closes the old connection and cancels local requests; callbacks from the old profile are ignored. It does not cancel work already running on either host.

On upgrade, the existing pairing and database are retained in the initial profile (port 8443 selects Copilot API; other existing addresses select Live VS Code). The second profile starts empty. No host token or history is copied to the other profile. HTTP, WebSocket-only, credential-bearing, query-string, and fragment URLs are rejected. The host certificate must chain to a certificate trusted by Android and its hostname must match the URL.

The host URL, connection details, **Manage paired devices**, and **Unpair** are in Settings rather than above the conversation. Changing a paired mode's address requires unpairing that mode first, preventing its bearer token from being sent to a different host. Revoking this phone removes that mode's local token and cached conversations; **Unpair** only erases that mode's local credentials and cache. The other profile and host histories remain intact.

Conversations and sequenced events are stored in Room. On WebSocket reconnect, the client requests missed events after the last locally stored sequence and follows `nextAfter` while `hasMore` is true. Events are handled as flattened JSON objects whose top-level `sequence`, `conversationId`, and `type` accompany their event-specific fields. Text and question/approval responses use the documented WebSocket packets; voice is recorded as AAC/MPEG-4 while the mic button is held, then uploaded as `recording.m4a` on release. Microphone permission is requested on first use. Approval dialogs show the exact operation and its details; biometric confirmation can optionally be enabled on supported phones.

The chat fills the screen beneath a compact mode/connection header. The conversation icon opens a conversation picker with create/delete controls. The view combines streamed text deltas into one assistant message and renders common Markdown (headings, lists, emphasis, quotes, and fenced code). Message text can be selected and copied. Tool activity is grouped by tool call. Scrolling up pauses automatic scrolling; **Jump to latest** returns to the newest messages. The layout accounts for Android safe-area and keyboard insets. Disconnected sends preserve the typed draft. The microphone shows a recording indicator, uploads on release, and cancels without sending if the gesture is canceled or the app leaves the foreground.

Deleting a Copilot API conversation removes it from the phone and host; deleting a Live VS Code conversation only removes relay history, not the actual VS Code chat. The confirmation explains the active mode's behavior. Server-side deletion is blocked while a response is running.

## Read short responses aloud

Enable **Settings → Read short responses aloud** (off by default). Full detailed responses are always displayed and stored unchanged. For each new completed reply in the selected, foreground conversation, the phone requests `POST /api/voice/summary` with `{ "text": "<full response>" }` from that mode's authenticated host, then speaks the returned `{ "text": "<short summary>" }` using Android text-to-speech. The summary is a separate stateless AI request, not another message or a tool command. It adds provider usage and sends that response to OpenAI using the host's explicit key.

Update/restart both hosts before using this setting. They require their existing explicit OpenAI voice key (`OPENAI_API_KEY` for Copilot API, `HOST_UI_OPENAI_API_KEY` for Live VS Code). Optional model settings: `OPENAI_SUMMARY_MODEL` / `HOST_UI_OPENAI_SUMMARY_MODEL`, default `gpt-4o-mini`. The host accepts at most 20,000 characters, requests a short plain-text summary preserving important warnings, and rejects invalid output rather than silently reading a truncated reply.

Install a downloaded Android TTS voice matching the phone's language (Android **Text-to-speech settings**). Only a local, non-network voice is selected. The stop icon stops speech or a pending summary; starting the microphone also stops it. Backgrounding the app, changing profiles/conversations, or turning the setting off stops playback. Old reconnect/replay events and duplicate persisted events are never read. Missing keys, unsupported hosts, provider failures and TTS errors are shown explicitly; detailed chat remains usable. Summaries can omit details or be wrong: use the full reply for decisions and safety warnings.

## Validation and remaining device checks

The debug APK is built with JDK 17 / SDK 35. Automated unit tests cover protocol packets, timelines, mode selection/migration routing, and live-read gating (replay, duplicate, wrong-conversation, disabled and incomplete messages). Android lint and both host suites also run. A phone/emulator is still required to verify the visual layout, upgrade migration of actual Keystore credentials, mode switching/pairing, and real TTS/audio behavior end-to-end.

Server address, paired token, and conversation cache stay on this device. The application has no arbitrary command execution feature.
