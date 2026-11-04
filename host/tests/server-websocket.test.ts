import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { CopilotService } from "../src/copilot.js";
import type { BridgeStore } from "../src/store.js";
import { registerWebSocketRoute, type ClientConnection } from "../src/server.js";

describe("WebSocket authentication timeout", () => {
  let app: FastifyInstance | undefined;
  let client: WebSocket | undefined;

  afterEach(async () => {
    client?.terminate();
    client = undefined;
    if (app) await app.close();
    app = undefined;
  });

  it("closes unauthenticated connections without crashing the host", async () => {
    app = Fastify();
    app.register(websocket);
    const store = {
      authenticate: () => undefined,
      deviceIsActive: () => false,
      getConversation: () => undefined
    } satisfies Pick<BridgeStore, "authenticate" | "deviceIsActive" | "getConversation">;
    const copilot = {
      sendMessage: async () => undefined,
      resolveApproval: () => false,
      resolveQuestion: () => false
    } satisfies Pick<CopilotService, "sendMessage" | "resolveApproval" | "resolveQuestion">;
    const clients = new Set<ClientConnection>();
    app.register(async (websocketRoutes) => {
      registerWebSocketRoute(websocketRoutes, store, copilot, clients);
    });

    await app.ready();
    client = await app.injectWS("/api/ws");
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket did not close after the authentication deadline")), 6_000);
      client?.once("close", (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });

    await expect(closed).resolves.toEqual({ code: 1008, reason: "Authentication required" });
  }, 10_000);
});
