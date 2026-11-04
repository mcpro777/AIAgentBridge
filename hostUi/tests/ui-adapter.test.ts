import { describe, expect, it } from "vitest";
import { parseSnapshot, WindowsUiAdapter } from "../src/ui-adapter.js";

describe("Windows UI snapshot contract", () => {
  it("accepts verified transcript rows and explicit completion", () => {
    const snapshot = {
      targetId: "bound-session",
      busy: false,
      messages: [
        { id: "request-1", role: "user", text: "Hello" },
        { id: "response-1", role: "assistant", text: "Hi", completed: true }
      ]
    };
    expect(parseSnapshot(snapshot)).toEqual(snapshot);
  });

  it("preserves blocked UI status instead of treating it as a response", () => {
    expect(parseSnapshot({
      targetId: "bound-session", busy: true, messages: [], blocked: "Local approval required"
    }).blocked).toBe("Local approval required");
  });

  it("does not start another native worker after the adapter has closed", async () => {
    const adapter = new WindowsUiAdapter();
    await adapter.close();
    await expect(adapter.inspect()).rejects.toThrow("adapter is closed");
    await expect(adapter.submit("not sent", { targetId: "test", busy: false, messages: [] })).rejects.toThrow("adapter is closed");
  });

  it.each([
    null,
    { targetId: "", busy: false, messages: [] },
    { targetId: "session", busy: "false", messages: [] },
    { targetId: "session", busy: false, messages: [{ id: "", role: "assistant", text: "old" }] },
    { targetId: "session", busy: false, messages: [{ id: "1", role: "system", text: "hidden" }] },
    { targetId: "session", busy: false, messages: [{ id: "1", role: "assistant", text: "old", completed: "true" }] }
  ])("rejects malformed or ambiguous snapshot %j", (value) => {
    expect(() => parseSnapshot(value)).toThrow();
  });
});
