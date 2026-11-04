import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import selfsigned from "selfsigned";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { createServer } from "../src/server.js";
import { BridgeStore } from "../src/store.js";
import { RelayService } from "../src/relay.js";
import { validateBindAddress } from "../src/config.js";
import type { RuntimeConfig } from "../src/config.js";

let app: FastifyInstance;
let store: BridgeStore;
let token: string;
let config: RuntimeConfig;
const sockets: WebSocket[] = [];
let tls: { key: Buffer; cert: Buffer };
const testApiKey = "test-only-not-a-real-openai-key";
beforeAll(async () => {
  const certificate = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { keySize: 2048 });
  tls = { key: Buffer.from(certificate.private), cert: Buffer.from(certificate.cert) };
});
beforeEach(async () => {
  store = new BridgeStore(":memory:");
  token = store.pair(store.createPairingCode(), "test")!.token;
  const relay = new RelayService({
    inspect: async () => ({ targetId: "live", busy: false, messages: [], blocked: "approval required" }),
    submit: async () => undefined, close: async () => undefined
  }, store);
  config = { bind: "127.0.0.1", port: 8444, dataDirectory: ".data", tlsCertPath: "", tlsKeyPath: "",
    sttModel: "test", ttsModel: "test", summaryModel: "gpt-4o-mini" };
  app = createServer(config, store, relay, tls);
  app.log.level = "silent";
  await app.ready();
});
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.terminate());
  await app?.close();
  store.close();
  vi.unstubAllGlobals();
});
const headers = () => ({ authorization: `Bearer ${token}` });
function packet(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No websocket packet")), 2_000);
    socket.once("message", (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString()) as Record<string, unknown>); });
  });
}
describe("authenticated Android protocol", () => {
  it("authenticates query-string API routes and creates distinct phone conversations", async () => {
    expect((await app.inject("/api/conversations?after=0")).statusCode).toBe(401);
    expect((await app.inject("/api/health?probe=1")).statusCode).toBe(200);
    const first = await app.inject({ method: "POST", url: "/api/conversations", headers: headers() });
    const second = await app.inject({ method: "POST", url: "/api/conversations", headers: headers() });
    expect(first.json().id).not.toBe(second.json().id);
    expect(first.json().title).toBe("Live VS Code");
    const id = first.json().id as string;
    const secondId = second.json().id as string;
    expect((await app.inject({ url: "/api/conversations", headers: headers() })).json().conversations).toHaveLength(2);
    store.appendEvent(id, "error", { message: "persisted" });
    expect((await app.inject({ url: `/api/conversations/${secondId}/events?after=0`, headers: headers() })).json().events).toEqual([]);
    expect((await app.inject({ url: `/api/conversations/${id}/events?after=0`, headers: headers() })).json().events[0].message).toBe("persisted");
    expect((await app.inject({ url: `/api/conversations/${id}/events?after=-1`, headers: headers() })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/voice/speech", headers: headers(), payload: { text: "hello" } })).statusCode).toBe(503);
    expect((await app.inject({ method: "POST", url: "/api/voice/summary", headers: headers(), payload: { text: "hello" } })).statusCode).toBe(503);
    expect((await app.inject({ method: "DELETE", url: `/api/conversations/${id}`, headers: headers() })).statusCode).toBe(204);
    expect(store.getConversation(secondId)?.id).toBe(secondId);
  });
  it("authenticates spoken summaries and handles provider responses explicitly", async () => {
    config.openAiApiKey = testApiKey;
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
      return new Response(JSON.stringify({ choices: [{ message: { content: "A concise spoken summary." } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect((await app.inject({ method: "POST", url: "/api/voice/summary", payload: { text: "Untrusted source text" } })).statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    for (const payload of [null, { text: "" }, { text: "x".repeat(20_001) }]) {
      expect((await app.inject({ method: "POST", url: "/api/voice/summary", headers: headers(), payload })).statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    const success = await app.inject({ method: "POST", url: "/api/voice/summary", headers: headers(), payload: { text: "Untrusted source text" } });
    expect(success.statusCode).toBe(200);
    expect(success.json()).toEqual({ text: "A concise spoken summary." });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not exposed", { status: 500 })));
    const failure = await app.inject({ method: "POST", url: "/api/voice/summary", headers: headers(), payload: { text: "source" } });
    expect(failure.statusCode).toBe(502);
    expect(failure.json()).toEqual({ error: "Summary provider request failed" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); }));
    const timeout = await app.inject({ method: "POST", url: "/api/voice/summary", headers: headers(), payload: { text: "source" } });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json()).toEqual({ error: "Summary provider timed out" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    const invalid = await app.inject({ method: "POST", url: "/api/voice/summary", headers: headers(), payload: { text: "source" } });
    expect(invalid.statusCode).toBe(502);
    expect(invalid.json()).toEqual({ error: "Summary provider returned invalid output" });

    const overlong = Array.from({ length: 61 }, (_, index) => `word${index}`).join(" ");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: overlong } }]
    }), { status: 200 })));
    const long = await app.inject({ method: "POST", url: "/api/voice/summary", headers: headers(), payload: { text: "source" } });
    expect(long.statusCode).toBe(502);
    expect(long.json()).toEqual({ error: "Summary provider returned overlong output" });
  });
  it("pairs only once and limits attempts even with query parameters", async () => {
    const code = store.createPairingCode();
    const options = { method: "POST" as const, url: "/api/pair?x=1", payload: { code, deviceName: "phone" } };
    expect((await app.inject(options)).statusCode).toBe(201);
    expect((await app.inject(options)).statusCode).toBe(401);
    for (let i = 0; i < 6; i++) await app.inject(options);
    expect((await app.inject(options)).statusCode).toBe(429);
  });
  it("authenticates websocket first, persists relay errors and revokes sockets", async () => {
    const socket = await app.injectWS("/api/ws?x=1");
    sockets.push(socket);
    let next = packet(socket);
    socket.send(JSON.stringify({ type: "auth", token }));
    expect(await next).toEqual({ type: "auth.ok" });
    const id = store.createConversation().id;
    next = packet(socket);
    socket.send(JSON.stringify({ type: "message.create", conversationId: id, text: "question" }));
    expect(await next).toMatchObject({ type: "error", conversationId: id });
    expect(store.listEvents(id, 0).at(-1)?.payload.message).toContain("locally");
    next = packet(socket);
    socket.send(JSON.stringify({ type: "approval.respond", approvalId: "ignored", decision: "approve" }));
    expect((await next).message).toContain("locally");
    const deviceId = store.authenticate(token)!;
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    expect((await app.inject({ method: "DELETE", url: `/api/devices/${deviceId}`, headers: headers() })).statusCode).toBe(204);
    expect(await closed).toBe(1008);
    expect((await app.inject({ url: "/api/devices", headers: headers() })).statusCode).toBe(401);
  });
  it("rejects unauthenticated websocket commands", async () => {
    const socket = await app.injectWS("/api/ws");
    sockets.push(socket);
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send(JSON.stringify({ type: "message.create", text: "no" }));
    expect(await closed).toBe(1008);
  });
  it("paginates replay without losing the event cursor", async () => {
    const { id } = store.createConversation();
    for (let i = 0; i < 501; i++) store.appendEvent(id, "error", { message: `event ${i}` });
    const first = (await app.inject({ url: `/api/conversations/${id}/events?after=0`, headers: headers() })).json();
    expect(first.events).toHaveLength(500);
    expect(first.hasMore).toBe(true);
    const second = (await app.inject({ url: `/api/conversations/${id}/events?after=${first.nextAfter}`, headers: headers() })).json();
    expect(second.events).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.events[0].message).toBe("event 500");
  });
  it("enforces websocket packet rate and rejects JSON null safely", async () => {
    const socket = await app.injectWS("/api/ws");
    sockets.push(socket);
    const authenticated = packet(socket);
    socket.send(JSON.stringify({ type: "auth", token }));
    await authenticated;
    const response = packet(socket);
    socket.send("null");
    expect((await response).type).toBe("error");
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    for (let i = 0; i < 60; i++) socket.send("{}");
    expect(await closed).toBe(1008);
  });
});
describe("private bind", () => {
  it("rejects public, wildcard and hostname binds", () => {
    for (const value of ["0.0.0.0", "::", "8.8.8.8", "example.com", "::ffff:127.0.0.1"]) expect(() => validateBindAddress(value)).toThrow();
    for (const value of ["127.0.0.1", "10.0.0.2", "192.168.1.2", "100.64.0.2", "::1", "fd00::1"]) expect(validateBindAddress(value)).toBe(value);
  });
});
