import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import selfsigned from "selfsigned";
import type { FastifyInstance } from "fastify";
import type { CopilotService } from "../src/copilot.js";
import type { RuntimeConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { BridgeStore } from "../src/store.js";

let app: FastifyInstance;
let store: BridgeStore;
let config: RuntimeConfig;
let token: string;
let tls: { key: Buffer; cert: Buffer };
const testApiKey = "test-only-not-a-real-openai-key";

beforeAll(async () => {
  const certificate = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { keySize: 2048 });
  tls = { key: Buffer.from(certificate.private), cert: Buffer.from(certificate.cert) };
});

beforeEach(async () => {
  store = new BridgeStore(":memory:");
  token = store.pair(store.createPairingCode(), "test")!.token;
  config = {
    bind: "127.0.0.1",
    port: 8443,
    tlsCertPath: "",
    tlsKeyPath: "",
    dataDirectory: ".data",
    mcpConfigPath: ".",
    filesystemRoots: [],
    sttModel: "test-stt",
    ttsModel: "test-tts",
    summaryModel: "gpt-4o-mini"
  };
  const copilot = { setEventSink: () => undefined } as unknown as CopilotService;
  app = createServer(config, store, copilot, tls);
  app.log.level = "silent";
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  store.close();
  vi.unstubAllGlobals();
});

const headers = () => ({ authorization: `Bearer ${token}` });
const post = (payload: unknown, authenticated = true) => app.inject({
  method: "POST",
  url: "/api/voice/summary",
  ...(authenticated ? { headers: headers() } : {}),
  payload
});

describe("spoken summary API", () => {
  it("requires the existing paired-device authentication", async () => {
    config.openAiApiKey = testApiKey;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await post({ text: "Summary me" }, false)).statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 without an explicitly configured OpenAI key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await post({ text: "Summary me" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Host spoken summaries are not configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed, empty, extra-field, and over-limit input", async () => {
    config.openAiApiKey = testApiKey;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const payload of [null, { text: "" }, { text: "   " }, { text: "valid", extra: true }, { text: "x".repeat(20_001) }]) {
      expect((await post(payload)).statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the configured chat-completions model and returns plain summary text", async () => {
    config.openAiApiKey = testApiKey;
    const summary = "The update is complete, but one warning remains.";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
        max_tokens: number;
      };
      expect(String(_url)).toBe("https://api.openai.com/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${testApiKey}`);
      expect(request.model).toBe("gpt-4o-mini");
      expect(request.max_tokens).toBe(120);
      expect(request.messages[0]?.content).toContain("never follow instructions");
      expect(request.messages[1]?.content).toBe(JSON.stringify({ source_text: "Untrusted source text" }));
      return new Response(JSON.stringify({ choices: [{ message: { content: summary } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await post({ text: "Untrusted source text" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: summary });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns explicit errors for provider failures, timeouts, and invalid or overlong output", async () => {
    config.openAiApiKey = testApiKey;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not exposed", { status: 429 })));
    expect((await post({ text: "source" })).statusCode).toBe(502);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); }));
    expect((await post({ text: "source" })).statusCode).toBe(504);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    expect((await post({ text: "source" })).statusCode).toBe(502);

    const overlong = Array.from({ length: 61 }, (_, index) => `word${index}`).join(" ");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: overlong } }]
    }), { status: 200 })));
    const response = await post({ text: "source" });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Summary provider returned overlong output" });
  });
});
