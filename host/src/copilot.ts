import { createHash } from "node:crypto";
import path from "node:path";
import {
  CopilotClient,
  ToolSet,
  type CopilotSession,
  type PermissionRequest,
  type PermissionRequestResult
} from "@github/copilot-sdk";
import type { RuntimeConfig, LoadedMcpConfig } from "./config.js";
import { logActivity } from "./activity-log.js";
import { isAutoApprovedMcpOperation, resolveConfiguredMcpToolId } from "./mcp-policy.js";
import type { BridgeStore } from "./store.js";

type BridgeEvent = {
  sequence: number;
  conversationId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type EventSink = (event: BridgeEvent) => void;
type UserInputRequest = { question: string; choices?: string[]; allowFreeform?: boolean };

const permissionTimeoutMs = 2 * 60_000;
const questionTimeoutMs = 5 * 60_000;
const maxPermissionBytes = 32 * 1024;

export class ConversationBusyError extends Error {}

function redactText(value: string): string {
  return value
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested value omitted]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/token|secret|password|credential|authorization|api.?key/i.test(key)) return [key, "[REDACTED]"];
      return [key, redact(item, depth + 1)];
    }));
  }
  return value;
}

function permissionDetails(request: PermissionRequest): Record<string, unknown> {
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized, "utf8") > maxPermissionBytes) {
    throw new Error("Permission request exceeds the safe approval display limit");
  }
  const details = redact(request) as Record<string, unknown>;
  return {
    ...details,
    operationFingerprint: createHash("sha256").update(serialized).digest("hex")
  };
}

export class CopilotService {
  private readonly client: CopilotClient;
  private readonly sessions = new Map<string, CopilotSession>();
  private readonly opening = new Map<string, Promise<CopilotSession>>();
  private readonly approvalWaiters = new Map<string, (approved: boolean) => void>();
  private readonly questionWaiters = new Map<string, (answer: string) => void>();
  private readonly activeTurns = new Map<string, number>();
  private readonly pendingSends = new Map<string, number>();
  private readonly deletingConversations = new Set<string>();
  private publish: EventSink;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly mcpConfig: LoadedMcpConfig,
    private readonly store: BridgeStore,
    publish: EventSink
  ) {
    this.publish = publish;
    const expiredInteractions = this.store.expirePendingInteractions();
    for (const approval of expiredInteractions.approvals) {
      this.emit(approval.conversationId, "approval.completed", {
        approvalId: approval.id,
        decision: "deny",
        reason: "host-restarted"
      });
    }
    for (const question of expiredInteractions.questions) {
      this.emit(question.conversationId, "question.expired", {
        questionId: question.id,
        reason: "host-restarted"
      });
    }
    const runtimeEnvironment: Record<string, string | undefined> = {};
    for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
      const value = process.env[name];
      if (value) runtimeEnvironment[name] = value;
    }
    this.client = new CopilotClient({
      mode: "empty",
      baseDirectory: path.resolve(config.dataDirectory, "copilot"),
      workingDirectory: config.filesystemRoots[0] ?? config.dataDirectory,
      useLoggedInUser: false,
      env: runtimeEnvironment,
      ...(config.githubToken ? { gitHubToken: config.githubToken } : {}),
      logLevel: "warning"
    });
    logActivity("copilot.client.created", { workingDirectory: config.filesystemRoots[0] ?? config.dataDirectory });
  }

  async start(): Promise<void> {
    logActivity("copilot.client.starting");
    await this.client.start();
    logActivity("copilot.client.started");
  }

  setEventSink(publish: EventSink): void {
    this.publish = publish;
  }

  private emit(conversationId: string, type: string, payload: Record<string, unknown>): void {
    const event = this.store.appendEvent(conversationId, type, payload);
    logActivity("conversation.event", { conversationId, type, payload });
    this.publish(event);
  }

  private waitForApproval(conversationId: string, request: PermissionRequest): Promise<boolean> {
    const details = permissionDetails(request);
    const approval = this.store.createApproval(conversationId, details, permissionTimeoutMs);
    this.emit(conversationId, "approval.requested", {
      approvalId: approval.id,
      operation: details,
      expiresAt: approval.expiresAt
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvalWaiters.delete(approval.id);
        this.store.expireApproval(approval.id);
        this.emit(conversationId, "approval.completed", { approvalId: approval.id, decision: "deny", reason: "expired" });
        resolve(false);
      }, permissionTimeoutMs);
      this.approvalWaiters.set(approval.id, (approved) => {
        clearTimeout(timer);
        this.approvalWaiters.delete(approval.id);
        resolve(approved);
      });
    });
  }

  private async handlePermission(conversationId: string, request: PermissionRequest): Promise<PermissionRequestResult> {
    if (!["shell", "write", "read", "url", "mcp", "custom-tool"].includes(request.kind)) {
      return { kind: "reject", feedback: "AgentBridge denies unknown tool permission types." };
    }
    if (request.kind === "mcp") {
      const toolId = resolveConfiguredMcpToolId(request, this.mcpConfig.availableTools);
      if (!toolId) {
        logActivity("mcp.permission.rejected", {
          conversationId,
          serverName: request.serverName,
          toolName: request.toolName,
          readOnly: request.readOnly,
          configuredTools: this.mcpConfig.availableTools,
          reason: "not_explicitly_configured"
        });
        return { kind: "reject", feedback: "AgentBridge denies MCP tools not explicitly configured by the host." };
      }
      if (isAutoApprovedMcpOperation(request, this.mcpConfig.availableTools)) {
        logActivity("mcp.permission.auto_approved", {
          conversationId,
          serverName: request.serverName,
          toolName: request.toolName,
          arguments: request.args
        });
        return { kind: "approve-once", approvedInteractively: false };
      }
    }
    try {
      const approved = await this.waitForApproval(conversationId, request);
      return approved
        ? { kind: "approve-once", approvedInteractively: true }
        : { kind: "reject", feedback: "The exact operation was not approved in AgentBridge." };
    } catch (error) {
      this.emit(conversationId, "error", { message: error instanceof Error ? error.message : "Permission request could not be displayed." });
      return { kind: "reject", feedback: "AgentBridge could not safely present this operation for approval." };
    }
  }

  private async handleQuestion(conversationId: string, request: UserInputRequest): Promise<{ answer: string; wasFreeform: boolean }> {
    const allowFreeform = request.allowFreeform ?? true;
    const question = this.store.createQuestion(
      conversationId,
      request.question,
      request.choices,
      allowFreeform,
      questionTimeoutMs
    );
    this.emit(conversationId, "question.asked", {
      questionId: question.id,
      prompt: request.question,
      ...(request.choices ? { choices: request.choices } : {}),
      allowFreeform,
      expiresAt: question.expiresAt
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.questionWaiters.delete(question.id);
        this.store.expireQuestion(question.id);
        this.emit(conversationId, "question.expired", { questionId: question.id, reason: "timeout" });
        resolve({ answer: "No answer was provided before the question expired.", wasFreeform: true });
      }, questionTimeoutMs);
      this.questionWaiters.set(question.id, (answer) => {
        clearTimeout(timer);
        this.questionWaiters.delete(question.id);
        resolve({ answer, wasFreeform: !request.choices?.includes(answer) });
      });
    });
  }

  resolveApproval(approvalId: string, approved: boolean): boolean {
    const waiter = this.approvalWaiters.get(approvalId);
    if (!waiter || !this.store.resolveApproval(approvalId, approved)) return false;
    const approval = this.store.database.prepare(
      "SELECT conversation_id AS conversationId FROM approvals WHERE id = ?"
    ).get(approvalId) as { conversationId: string } | undefined;
    if (!approval) return false;
    this.emit(approval.conversationId, "approval.completed", { approvalId, decision: approved ? "approve" : "deny" });
    waiter(approved);
    return true;
  }

  resolveQuestion(questionId: string, answer: string): boolean {
    const waiter = this.questionWaiters.get(questionId);
    if (!waiter || !this.store.resolveQuestion(questionId, answer)) return false;
    const question = this.store.database.prepare(
      "SELECT conversation_id AS conversationId FROM questions WHERE id = ?"
    ).get(questionId) as { conversationId: string } | undefined;
    if (!question) return false;
    this.emit(question.conversationId, "question.answered", { questionId, answer });
    waiter(answer);
    return true;
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    if (this.deletingConversations.has(conversationId)) {
      throw new ConversationBusyError("Conversation deletion is already in progress.");
    }
    if ((this.activeTurns.get(conversationId) ?? 0) > 0 || (this.pendingSends.get(conversationId) ?? 0) > 0) {
      throw new ConversationBusyError("Wait for the current response to finish before deleting this conversation.");
    }
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) return false;

    this.deletingConversations.add(conversationId);
    try {
      const session = this.sessions.get(conversationId);
      if (session) {
        await session.disconnect();
        this.sessions.delete(conversationId);
      }
      if (conversation.sessionId) await this.client.deleteSession(conversation.sessionId);
      return this.store.deleteConversation(conversationId);
    } finally {
      this.deletingConversations.delete(conversationId);
    }
  }

  private async createOrResume(conversationId: string): Promise<CopilotSession> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;
    const current = this.opening.get(conversationId);
    if (current) return current;
    const opening = (async () => {
      const conversation = this.store.getConversation(conversationId);
      if (!conversation) throw new Error("Conversation not found");
      const permissionHandler = (request: PermissionRequest): Promise<PermissionRequestResult> =>
        this.handlePermission(conversationId, request);
      const availableTools = new ToolSet().addBuiltIn("ask_user");
      for (const configuredTool of this.mcpConfig.availableTools) {
        availableTools.addMcp(configuredTool.replace(/^mcp:/, ""));
      }
      const permissionAskRules = this.mcpConfig.availableTools.length > 0 ? ["Mcp(**)"] : [];
      const common = {
        availableTools,
        enableConfigDiscovery: false,
        mcpServers: this.mcpConfig.servers,
        workingDirectory: this.config.filesystemRoots[0] ?? this.config.dataDirectory,
        additionalDirectories: this.config.filesystemRoots.slice(1),
        streaming: true,
        managedSettings: {
          permissions: {
            disableBypassPermissionsMode: "disable",
            disableAssistedPermissionsMode: true,
            ask: permissionAskRules
          }
        },
        onPermissionRequest: permissionHandler,
        onUserInputRequest: (request: UserInputRequest) => this.handleQuestion(conversationId, request),
        systemMessage: {
          mode: "append" as const,
          content: [
            "You are AgentBridge, a private-LAN assistant.",
            "The host has enabled only explicitly configured MCP tools. Do not imply unavailable tools were used.",
            "Explicitly allowlisted read-only Home Assistant API tools and the configured Home Assistant service-call tool run without approval. For service calls, execute only the service and target the user requested. Other MCP operations require approval for this exact invocation.",
            "When a request is ambiguous in a way that blocks safe completion, ask the user a clarification question."
          ].join(" ")
        }
      };
      const session = conversation.sessionId
        ? await this.client.resumeSession(conversation.sessionId, common)
        : await this.client.createSession(common);
      this.store.setSessionId(conversationId, session.sessionId);
      this.sessions.set(conversationId, session);
      this.attachEvents(conversationId, session);
      logActivity("copilot.session.ready", {
        conversationId,
        sessionId: session.sessionId,
        resumed: Boolean(conversation.sessionId)
      });
      return session;
    })();
    this.opening.set(conversationId, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(conversationId);
    }
  }

  private attachEvents(conversationId: string, session: CopilotSession): void {
    const toolNames = new Map<string, string>();
    session.on("session.start", (event) => {
      logActivity("copilot.session.started", { conversationId, data: event.data });
    });
    session.on("session.idle", (event) => {
      logActivity("copilot.session.idle", { conversationId, data: event.data });
      if ((this.pendingSends.get(conversationId) ?? 0) === 0) this.activeTurns.delete(conversationId);
    });
    session.on("assistant.turn_start", (event) => {
      logActivity("copilot.turn.started", { conversationId, data: event.data });
    });
    session.on("assistant.turn_end", (event) => {
      logActivity("copilot.turn.completed", { conversationId, data: event.data });
      this.decrementCount(this.activeTurns, conversationId);
    });
    session.on("assistant.message_delta", (event) => {
      this.emit(conversationId, "message.delta", {
        messageId: event.data.messageId,
        delta: redactText(event.data.deltaContent)
      });
    });
    session.on("assistant.message", (event) => {
      const text = redactText(event.data.content);
      if (!text.trim()) return;
      this.emit(conversationId, "message.completed", {
        messageId: event.data.messageId,
        text
      });
    });
    session.on("tool.execution_start", (event) => {
      toolNames.set(event.data.toolCallId, event.data.toolName);
      logActivity("copilot.tool.started", { conversationId, data: event.data });
      this.emit(conversationId, "tool.status", {
        toolCallId: event.data.toolCallId,
        toolName: event.data.toolName,
        status: "started",
        summary: redact(event.data.arguments)
      });
    });
    session.on("tool.execution_complete", (event) => {
      logActivity("copilot.tool.completed", {
        conversationId,
        toolName: toolNames.get(event.data.toolCallId) ?? "unknown",
        data: event.data
      });
      this.emit(conversationId, "tool.status", {
        toolCallId: event.data.toolCallId,
        toolName: toolNames.get(event.data.toolCallId) ?? "unknown",
        status: "completed",
        summary: event.data.success ? "Completed" : "Failed"
      });
      toolNames.delete(event.data.toolCallId);
    });
    session.on("session.error", (event) => {
      logActivity("copilot.session.error", { conversationId, data: event.data });
      if ((this.pendingSends.get(conversationId) ?? 0) === 0) this.activeTurns.delete(conversationId);
      this.emit(conversationId, "error", { message: redact(event.data.message) });
    });
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (this.deletingConversations.has(conversationId)) {
      throw new ConversationBusyError("This conversation is being deleted.");
    }
    this.activeTurns.set(conversationId, (this.activeTurns.get(conversationId) ?? 0) + 1);
    this.pendingSends.set(conversationId, (this.pendingSends.get(conversationId) ?? 0) + 1);
    let accepted = false;
    try {
      let session: CopilotSession;
      try {
        session = await this.createOrResume(conversationId);
      } catch (error) {
        if (this.store.getConversation(conversationId)) {
          this.emit(conversationId, "error", {
            message: error instanceof Error ? redactText(error.message) : "Copilot session could not be opened."
          });
        }
        throw error;
      }
      const conversation = this.store.getConversation(conversationId);
      if (!conversation) throw new Error("Conversation not found");
      const title = redactText(text.replace(/\s+/g, " ").trim().slice(0, 100));
      if (conversation.title === "New conversation" && title) this.store.updateConversationTitle(conversationId, title);
      this.emit(conversationId, "message.user", { text });
      try {
        await session.send({ prompt: text });
        accepted = true;
      } catch (error) {
        if (this.store.getConversation(conversationId)) {
          this.emit(conversationId, "error", {
            message: error instanceof Error ? redactText(error.message) : "Copilot message could not be sent."
          });
        }
        throw error;
      }
    } finally {
      this.decrementCount(this.pendingSends, conversationId);
      if (!accepted) this.decrementCount(this.activeTurns, conversationId);
    }
  }

  private decrementCount(counts: Map<string, number>, conversationId: string): void {
    const count = (counts.get(conversationId) ?? 1) - 1;
    if (count <= 0) counts.delete(conversationId);
    else counts.set(conversationId, count);
  }

  async stop(): Promise<void> {
    logActivity("copilot.client.stopping");
    for (const [approvalId, waiter] of this.approvalWaiters) {
      this.store.expireApproval(approvalId);
      waiter(false);
    }
    for (const [questionId, waiter] of this.questionWaiters) {
      this.store.expireQuestion(questionId);
      waiter("No answer was provided before the host shut down.");
    }
    for (const session of this.sessions.values()) await session.disconnect();
    this.sessions.clear();
    await this.client.stop();
    logActivity("copilot.client.stopped");
  }
}
