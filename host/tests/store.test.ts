import { afterEach, describe, expect, it } from "vitest";
import { BridgeStore } from "../src/store.js";

describe("BridgeStore", () => {
  let store: BridgeStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it("consumes pairing codes once and supports device revocation", () => {
    store = new BridgeStore(":memory:");
    const code = store.createPairingCode();
    expect(code).toHaveLength(16);
    const first = store.pair(code, "Phone");

    expect(first).toBeDefined();
    expect(store.pair(code, "Second phone")).toBeUndefined();
    expect(store.authenticate(first!.token)).toBe(first!.deviceId);
    expect(store.revokeDevice(first!.deviceId)).toBe(true);
    expect(store.authenticate(first!.token)).toBeUndefined();
  });

  it("replays events in sequence order", () => {
    store = new BridgeStore(":memory:");
    const conversation = store.createConversation();
    const first = store.appendEvent(conversation.id, "message.user", { text: "hello" });
    const second = store.appendEvent(conversation.id, "message.completed", { text: "hi" });

    expect(store.listEvents(conversation.id, first.sequence)).toEqual([second]);
  });

  it("deletes a conversation and all associated events and interactions", () => {
    store = new BridgeStore(":memory:");
    const conversation = store.createConversation();
    store.appendEvent(conversation.id, "message.user", { text: "hello" });
    const approval = store.createApproval(conversation.id, { operation: "write" }, 60_000);
    const question = store.createQuestion(conversation.id, "Continue?", undefined, true, 60_000);

    expect(store.deleteConversation(conversation.id)).toBe(true);
    expect(store.getConversation(conversation.id)).toBeUndefined();
    expect(store.listEvents(conversation.id, 0)).toEqual([]);
    expect(store.resolveApproval(approval.id, true)).toBe(false);
    expect(store.resolveQuestion(question.id, "yes")).toBe(false);
    expect(store.deleteConversation(conversation.id)).toBe(false);
  });

  it("requires a pending unexpired approval and question", () => {
    store = new BridgeStore(":memory:");
    const conversation = store.createConversation();
    const approval = store.createApproval(conversation.id, { operation: "write" }, 60_000);
    const question = store.createQuestion(conversation.id, "Continue?", ["yes"], false, 60_000);

    expect(store.resolveApproval(approval.id, true)).toBe(true);
    expect(store.resolveApproval(approval.id, false)).toBe(false);
    expect(store.resolveQuestion(question.id, "perhaps")).toBe(false);
    expect(store.resolveQuestion(question.id, "yes")).toBe(true);
    expect(store.resolveQuestion(question.id, "no")).toBe(false);
  });

  it("expires pending interactions on restart", () => {
    store = new BridgeStore(":memory:");
    const conversation = store.createConversation();
    const approval = store.createApproval(conversation.id, { operation: "write" }, 60_000);
    const question = store.createQuestion(conversation.id, "Continue?", undefined, true, 60_000);

    expect(store.expirePendingInteractions()).toEqual({
      approvals: [{ id: approval.id, conversationId: conversation.id }],
      questions: [{ id: question.id, conversationId: conversation.id }]
    });
    expect(store.resolveApproval(approval.id, true)).toBe(false);
    expect(store.resolveQuestion(question.id, "yes")).toBe(false);
  });
});
