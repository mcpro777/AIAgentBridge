import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  completed?: boolean;
}

export interface UiSnapshot {
  targetId: string;
  busy: boolean;
  messages: UiMessage[];
  blocked?: string;
}

export interface UiAdapter {
  inspect(): Promise<UiSnapshot>;
  submit(text: string, expected: UiSnapshot): Promise<void>;
  close(): Promise<void>;
}

export const automationScript = fileURLToPath(new URL("../automation/bridge.ps1", import.meta.url));
export const powershellExecutable = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSnapshot(value: unknown): UiSnapshot {
  if (!record(value) || typeof value.targetId !== "string" || !value.targetId ||
      typeof value.busy !== "boolean" || !Array.isArray(value.messages) ||
      (value.blocked !== undefined && typeof value.blocked !== "string")) {
    throw new Error("The Windows UI worker returned an invalid snapshot.");
  }
  const messages: UiMessage[] = value.messages.map((message: unknown) => {
    if (!record(message) || typeof message.id !== "string" || !message.id ||
        (message.role !== "user" && message.role !== "assistant") ||
        typeof message.text !== "string" ||
        (message.completed !== undefined && typeof message.completed !== "boolean")) {
      throw new Error("The Windows UI worker returned an invalid chat message.");
    }
    return {
      id: message.id,
      role: message.role,
      text: message.text,
      ...(typeof message.completed === "boolean" ? { completed: message.completed } : {})
    };
  });
  return {
    targetId: value.targetId,
    busy: value.busy,
    messages,
    ...(typeof value.blocked === "string" ? { blocked: value.blocked } : {})
  };
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WindowsUiAdapter implements UiAdapter {
  private worker: ChildProcessWithoutNullStreams | undefined;
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly targetFile = path.resolve(process.env.UI_TARGET_FILE || ".data\\ui-target.json"),
    private readonly commandTimeoutMs = 20_000
  ) {}

  async inspect(): Promise<UiSnapshot> {
    return parseSnapshot(await this.request("inspect"));
  }

  async submit(text: string, expected: UiSnapshot): Promise<void> {
    const result = await this.request("submit", text, expected);
    if (!record(result) || result.submitted !== true) {
      throw new Error("The Windows UI worker did not confirm submission. Do not retry blindly; inspect VS Code.");
    }
  }

  private startWorker(): ChildProcessWithoutNullStreams {
    if (this.closed) throw new Error("The UI adapter is closed.");
    if (this.worker) return this.worker;
    if (process.platform !== "win32") throw new Error("The UI relay requires Windows with an unlocked interactive desktop.");
    const worker = spawn(powershellExecutable, [
      "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
      "-File", automationScript, "-TargetFile", this.targetFile
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.worker = worker;
    const lines = createInterface({ input: worker.stdout });
    lines.on("line", (line) => {
      try {
        const response: unknown = JSON.parse(line);
        if (!record(response) || typeof response.id !== "number") throw new Error("Invalid UI worker response.");
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (typeof response.error === "string") pending.reject(new Error(response.error));
        else pending.resolve(response.result);
      } catch (error) {
        this.failWorker(worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
    worker.stderr.on("data", () => {
      this.failWorker(worker, new Error("Windows UI worker reported a startup/runtime error. Run npm run ui:inspect locally for details."));
    });
    worker.on("error", (error) => this.failWorker(worker, error));
    worker.on("exit", () => this.failWorker(worker, new Error("Windows UI worker exited. Check the bound VS Code window and desktop.")));
    return worker;
  }

  private failWorker(worker: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    worker.kill();
  }

  private request(command: "inspect" | "submit", text?: string, expected?: UiSnapshot): Promise<unknown> {
    const worker = this.startWorker();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failWorker(worker, new Error(
          "Windows UI command timed out. Submission state may be unknown; inspect VS Code before retrying."
        ));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.stdin.write(JSON.stringify({ id, command, ...(text !== undefined ? { text } : {}), ...(expected ? { expected } : {}) }) + "\n", (error) => {
        if (error) this.failWorker(worker, error);
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (worker) this.failWorker(worker, new Error("UI adapter is shutting down."));
  }
}
