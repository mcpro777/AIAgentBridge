import { afterEach, describe, expect, it } from "vitest";
import { BridgeStore } from "../src/store.js";
import { RelayService } from "../src/relay.js";
import type { UiAdapter, UiSnapshot } from "../src/ui-adapter.js";

const stores: BridgeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup(snapshots: UiSnapshot[]) {
  const store = new BridgeStore(":memory:");
  stores.push(store);
  let index = 0;
  let submits = 0;
  const adapter: UiAdapter = {
    inspect: async () => snapshots[Math.min(index++, snapshots.length - 1)]!,
    submit: async () => { submits++; },
    close: async () => undefined
  };
  const relay = new RelayService(adapter, store, { pollMs: 1, stableIdleMs: 5, deadlineMs: 40 });
  const id = store.createConversation().id;
  return { store, relay, id, submitted: () => submits };
}
const historic: UiSnapshot = { targetId: "target", busy: false, messages: [
  { id: "old-user", role: "user", text: "hello" }, { id: "old-assistant", role: "assistant", text: "secret history" }
] };
const answer: UiSnapshot = { ...historic, messages: [...historic.messages,
  { id: "new-user", role: "user", text: "question" }, { id: "new-assistant", role: "assistant", text: "new answer" }
] };

describe("live relay boundaries", () => {
  it("imports only a verified new answer, never historic messages", async () => {
    const { relay, store, id } = setup([historic, { ...answer, busy: true }, answer]);
    await relay.sendMessage(id, "question");
    const events = store.listEvents(id, 0);
    expect(events.filter((event) => event.type === "message.completed").map((event) => event.payload.text)).toEqual(["new answer"]);
    expect(JSON.stringify(events)).not.toContain("secret history");
  });
  it("never silently succeeds without a new user boundary", async () => {
    const { relay, store, id } = setup([historic]);
    await expect(relay.sendMessage(id, "question")).rejects.toThrow(/Timed out|deadline/);
    expect(store.listEvents(id, 0).at(-1)?.type).toBe("error");
    expect(store.listEvents(id, 0).some((event) => event.type === "message.completed")).toBe(false);
  });
  it("requires explicit completion when the adapter supplies completion markers", async () => {
    const incomplete = { ...answer, messages: answer.messages.map((message) => message.id === "new-assistant" ? { ...message, completed: false } : message) };
    const { relay, store, id } = setup([historic, incomplete]);
    await expect(relay.sendMessage(id, "question")).rejects.toThrow(/Timed out|deadline/);
    expect(store.listEvents(id, 0).some((event) => event.type === "message.completed")).toBe(false);
    const complete = { ...answer, messages: answer.messages.map((message) => message.id === "new-assistant" ? { ...message, completed: true } : message) };
    const successful = setup([historic, incomplete, complete]);
    await successful.relay.sendMessage(successful.id, "question");
    expect(successful.store.listEvents(successful.id, 0).filter((event) => event.type === "message.completed")).toHaveLength(1);
  });
  it("tracks a latched response when virtualization removes its verified user boundary", async () => {
    const partial = { ...answer, busy: true, messages: answer.messages.map((message) => message.id === "new-assistant" ? { ...message, text: "partial", completed: false } : message) };
    const virtualized: UiSnapshot = { targetId: "target", busy: false, messages: [
      { id: "new-assistant", role: "assistant", text: "complete response", completed: true },
      { id: "unseen-history", role: "assistant", text: "must not leak", completed: true }
    ] };
    const { relay, store, id } = setup([historic, partial, virtualized]);
    await relay.sendMessage(id, "question");
    expect(store.listEvents(id, 0).filter((event) => event.type === "message.completed").map((event) => event.payload.text)).toEqual(["complete response"]);
  });
  it("finishes explicitly completed replies immediately and accepts another message", async () => {
    const complete: UiSnapshot = {
      ...answer,
      messages: answer.messages.map((message) => message.role === "assistant" ? { ...message, completed: true } : message)
    };
    const second: UiSnapshot = {
      ...complete,
      messages: [...complete.messages,
        { id: "second-user", role: "user", text: "next question" },
        { id: "second-assistant", role: "assistant", text: "second answer", completed: true }
      ]
    };
    const store = new BridgeStore(":memory:");
    stores.push(store);
    const snapshots = [historic, complete, complete, second];
    let index = 0;
    let submits = 0;
    const relay = new RelayService({
      inspect: async () => snapshots[Math.min(index++, snapshots.length - 1)]!,
      submit: async () => { submits++; },
      close: async () => undefined
    }, store, { pollMs: 1, deadlineMs: 100, stableIdleMs: 10_000 });
    const id = store.createConversation().id;
    await relay.sendMessage(id, "question");
    await relay.sendMessage(id, "next question");
    expect(submits).toBe(2);
    expect(store.listEvents(id, 0).filter((event) => event.type === "message.completed")
      .map((event) => event.payload.text)).toEqual(["new answer", "second answer"]);
  });
  it("rejects mismatched submissions, changed targets, busy and blocked targets persistently", async () => {
    for (const snapshots of [
      [historic, { ...answer, messages: answer.messages.map((message) => message.id === "new-user" ? { ...message, text: "different" } : message) }],
      [historic, { ...answer, targetId: "other" }],
      [{ ...historic, busy: true }],
      [{ ...historic, blocked: "Approval required" }]
    ]) {
      const { relay, store, id } = setup(snapshots);
      await expect(relay.sendMessage(id, "question")).rejects.toThrow();
      expect(store.listEvents(id, 0).at(-1)?.type).toBe("error");
    }
  });
  it("follows a different active target on the next request into the same phone conversation", async () => {
    const first: UiSnapshot = { ...answer, messages: answer.messages.map((m) => ({ ...m, completed: true })) };
    const other: UiSnapshot = { targetId: "other-session", busy: false, messages: [
      { id: "other-history", role: "user", text: "private old question" }
    ] };
    const second: UiSnapshot = { ...other, messages: [...other.messages,
      { id: "other-user", role: "user", text: "second question" },
      { id: "other-answer", role: "assistant", text: "second session reply", completed: true }
    ] };
    const { relay, store, id, submitted } = setup([historic, first, other, second]);
    await relay.sendMessage(id, "question");
    await relay.sendMessage(id, "second question");
    expect(submitted()).toBe(2);
    expect(store.listEvents(id, 0).filter((e) => e.type === "message.completed")
      .map((e) => e.payload.text)).toEqual(["new answer", "second session reply"]);
    expect(store.listConversations()).toHaveLength(1);
    expect(JSON.stringify(store.listEvents(id, 0))).not.toContain("private old question");
  });
  it("serializes sends globally and deletes only cache after completion", async () => {
    const { relay, store, id, submitted } = setup([historic, answer]);
    const pending = relay.sendMessage(id, "question");
    await expect(relay.sendMessage(id, "again")).rejects.toThrow("busy");
    await expect(relay.deleteConversation(id)).rejects.toThrow("Wait");
    await pending;
    expect(submitted()).toBe(1);
    await expect(relay.deleteConversation(id)).resolves.toBe(true);
    expect(store.listConversations()).toEqual([]);
    expect(store.createConversation().title).toBe("Live VS Code");
  });
  it("keeps an in-flight reply in its originating phone conversation", async () => {
    const { relay, store, id } = setup([historic, answer]);
    const pending = relay.sendMessage(id, "question");
    const other = store.createConversation();
    expect(other.id).not.toBe(id);
    await pending;
    expect(store.listEvents(id, 0).filter((event) => event.type === "message.completed")
      .map((event) => event.payload.text)).toEqual(["new answer"]);
    expect(store.listEvents(other.id, 0)).toEqual([]);
    expect(store.listConversations()).toHaveLength(2);
  });
  it("rejects a competing local user boundary", async () => {
    const { relay, store, id } = setup([historic, { ...answer, busy: true }, { ...answer, messages: [...answer.messages, { id: "local", role: "user", text: "local input" }] }]);
    await expect(relay.sendMessage(id, "question")).rejects.toThrow("Chat changed locally");
    expect(store.listEvents(id, 0).at(-1)?.type).toBe("error");
  });
  it("bounds hung adapter calls and requires recovery instead of overlapping sends", async () => {
    const store = new BridgeStore(":memory:");
    stores.push(store);
    const relay = new RelayService({
      inspect: () => new Promise<UiSnapshot>(() => undefined),
      submit: async () => undefined, close: async () => undefined
    }, store, { deadlineMs: 10 });
    const id = store.createConversation().id;
    await expect(relay.sendMessage(id, "question")).rejects.toThrow("deadline");
    await expect(relay.sendMessage(id, "again")).rejects.toThrow("recovery");
    expect(store.listEvents(id, 0).filter((event) => event.type === "error")).toHaveLength(2);
    await relay.stop();
  });
  it("interrupts hung response inspection promptly on shutdown", async () => {
    const store = new BridgeStore(":memory:");
    stores.push(store);
    let closed = false;
    const relay = new RelayService({
      inspect: () => new Promise<UiSnapshot>(() => undefined),
      submit: async () => undefined, close: async () => { closed = true; }
    }, store, { deadlineMs: 180_000 });
    const pending = relay.sendMessage(store.createConversation().id, "question");
    const rejected = expect(pending).rejects.toThrow("stopped");
    await relay.stop();
    await rejected;
    expect(closed).toBe(true);
  });
});
