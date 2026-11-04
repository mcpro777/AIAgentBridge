import { randomUUID } from "node:crypto";
import type { UiAdapter, UiSnapshot } from "./ui-adapter.js";
import { BridgeStore, type StoredEvent } from "./store.js";

export class ConversationBusyError extends Error {}
export interface RelayOptions { pollMs: number; deadlineMs: number; stableIdleMs: number }
const defaults: RelayOptions = { pollMs: 500, deadlineMs: 180_000, stableIdleMs: 2_500 };

export class RelayService {
  private active = false;
  private stopped = false;
  private recoveryRequired = false;
  private submissionInFlight = false;
  private pending: Promise<void> | undefined;
  private cancelWait: (() => void) | undefined;
  private sink: (event: StoredEvent) => void = () => undefined;
  private readonly options: RelayOptions;

  constructor(private readonly adapter: UiAdapter, private readonly store: BridgeStore, options: Partial<RelayOptions> = {}) {
    this.options = { ...defaults, ...options };
  }

  setEventSink(sink: (event: StoredEvent) => void): void { this.sink = sink; }
  private emit(id: string, type: string, payload: Record<string, unknown>): void {
    this.sink(this.store.appendEvent(id, type, payload));
  }

  recordError(id: string, message: string): void {
    if (this.store.getConversation(id)) this.emit(id, "error", { message });
  }

  sendMessage(id: string, text: string): Promise<void> {
    if (!this.store.getConversation(id)) return Promise.reject(new Error("Conversation not found"));
    if (this.active || this.stopped || this.recoveryRequired) {
      const error = new ConversationBusyError("Live VS Code is busy, needs local recovery, or is shutting down; inspect locally and restart the relay after a timeout.");
      this.recordError(id, error.message);
      return Promise.reject(error);
    }
    this.active = true;
    const run = this.run(id, text).catch((error: unknown) => {
      if (this.submissionInFlight) this.recoveryRequired = true;
      this.recordError(id, error instanceof Error ? error.message : "UI relay failed");
      throw error;
    }).finally(() => { this.active = false; this.submissionInFlight = false; });
    this.pending = run;
    return run;
  }

  private check(snapshot: UiSnapshot, targetId?: string): void {
    if (!snapshot.targetId || (targetId !== undefined && snapshot.targetId !== targetId)) throw new Error("VS Code target changed; no response was imported.");
    if (snapshot.blocked) throw new Error(`Complete this interaction locally in VS Code: ${snapshot.blocked}`);
    const ids = snapshot.messages.map((message) => message.id);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("VS Code message identities are ambiguous.");
  }

  private async withinDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.recoveryRequired = true;
          reject(new Error("UI adapter deadline exceeded; inspect VS Code locally and restart the relay before retrying."));
        }, Math.max(1, deadline - Date.now()));
      }), new Promise<never>((_, reject) => {
        this.cancelWait = () => reject(new Error("UI relay stopped before response completion."));
        if (this.stopped) this.cancelWait();
      })]);
    } finally { clearTimeout(timer); this.cancelWait = undefined; }
  }

  private async run(id: string, text: string): Promise<void> {
    const deadline = Date.now() + this.options.deadlineMs;
    const before = await this.withinDeadline(this.adapter.inspect(), deadline);
    this.check(before);
    if (before.busy) throw new ConversationBusyError("VS Code is busy; wait for the local response to finish.");
    const oldIds = new Set(before.messages.map((message) => message.id));
    this.emit(id, "message.user", { text });
    this.emit(id, "status", { status: "thinking" });
    this.submissionInFlight = true;
    await this.withinDeadline(this.adapter.submit(text, before), deadline);
    let boundary: string | undefined;
    const captured = new Map<string, UiSnapshot["messages"][number]>();
    let stableSince = Date.now();
    let signature = "";
    while (!this.stopped && Date.now() < deadline) {
      const snapshot = await this.withinDeadline(this.adapter.inspect(), deadline);
      this.check(snapshot, before.targetId);
      const newUsers = snapshot.messages.filter((message) => message.role === "user" && !oldIds.has(message.id));
      if (!boundary && newUsers.length) {
        if (newUsers.length !== 1 || newUsers[0]!.text !== text) throw new Error("Could not verify the submitted user message; resolve the live chat locally.");
        boundary = newUsers[0]!.id;
      }
      if (boundary) {
        const index = snapshot.messages.findIndex((message) => message.id === boundary);
        if (index >= 0 && snapshot.messages[index]!.text !== text) throw new Error("Submitted message boundary changed.");
        if (newUsers.some((message) => message.id !== boundary)) throw new Error("Chat changed locally: another user message appeared; response capture stopped.");
        const following = index >= 0 ? snapshot.messages.slice(index + 1) : snapshot.messages;
        if (index >= 0 && following.some((message) => message.role === "user")) throw new Error("Chat changed locally: another user message appeared; response capture stopped.");
        for (const message of following) {
          if (message.role !== "assistant" || oldIds.has(message.id)) continue;
          // A virtualized boundary cannot establish provenance for previously unseen rows.
          if (index >= 0 || captured.has(message.id)) captured.set(message.id, message);
        }
        const answers = [...captured.values()];
        const hasCompletionMarkers = answers.some((message) => message.completed !== undefined);
        const completed = !hasCompletionMarkers || answers.every((message) => message.completed === true);
        const next = JSON.stringify(answers);
        if (snapshot.busy || next !== signature) stableSince = Date.now();
        signature = next;
        if (!snapshot.busy && completed && answers.some((message) => message.text.trim()) &&
            (hasCompletionMarkers || Date.now() - stableSince >= this.options.stableIdleMs)) {
          for (const answer of answers) {
            if (answer.text.trim()) this.emit(id, "message.completed", { messageId: randomUUID(), text: answer.text });
          }
          this.emit(id, "status", { status: "idle" });
          this.submissionInFlight = false;
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs));
    }
    this.recoveryRequired = true;
    throw new Error(this.stopped ? "UI relay stopped before response completion." : "Timed out verifying a new VS Code response; inspect the live chat locally and restart the relay before retrying.");
  }

  async deleteConversation(id: string): Promise<boolean> {
    if (this.active) {
      const message = "Wait for the live response before clearing the relay cache.";
      this.recordError(id, message);
      throw new ConversationBusyError(message);
    }
    return this.store.deleteConversation(id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelWait?.();
    await this.pending?.catch(() => undefined);
    await this.adapter.close();
  }
}
