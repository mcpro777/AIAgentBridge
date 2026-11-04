# AgentBridge host

The host provides the authenticated HTTPS API used by the Android client, including voice transcription, speech playback, and concise spoken summaries. Run from the repository's `host` folder with Node.js 24+:

```powershell
npm install
npm run typecheck
npm test
npm run build
npm start
```

Configure `.env` from `.env.example` and provide the TLS certificate/key paths. OpenAI voice features require the explicitly configured `OPENAI_API_KEY`; the optional `OPENAI_SUMMARY_MODEL` defaults to `gpt-4o-mini`.

The authenticated `POST /api/voice/summary` route accepts `{ "text": "..." }` with at most 20,000 characters and returns `{ "text": "..." }`. It requests a concise plain-text spoken summary (ideally one or two sentences and at most 60 words), preserving critical warnings and uncertainty. Source text is untrusted data, not instructions, and the response must not claim operations were performed. Detailed chat responses are unchanged. Missing API-key configuration returns 503; invalid input returns 400, and upstream, timeout, invalid, or overlong output failures return explicit errors without a silent fallback.
