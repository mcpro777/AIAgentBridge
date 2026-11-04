const sensitiveKeyPattern = /token|secret|password|passwd|credential|authorization|api[_-]?key|private[_-]?key/i;
const sensitiveAssignmentPattern = /(["']?[\w.-]*(?:token|secret|password|passwd|credential|authorization|api[_-]?key|private[_-]?key)[\w.-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s;}\r\n]+)/gi;
const sensitiveLinePattern = /(^|\r?\n)(\s*["']?[\w.-]*(?:token|secret|password|passwd|credential|authorization|api[_-]?key|private[_-]?key)[\w.-]*["']?\s*[:=]\s*)[^\r\n]*/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED TOKEN]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(sensitiveLinePattern, "$1$2[REDACTED]")
    .replace(sensitiveAssignmentPattern, "$1[REDACTED]");
}

export function redactForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 12) return "[nested value omitted]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const redacted = value.map((item) => redactForLog(item, depth + 1, seen));
    seen.delete(value);
    return redacted;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const redacted = Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[REDACTED]" : redactForLog(item, depth + 1, seen)
    ]));
    seen.delete(value);
    return redacted;
  }
  if (typeof value === "bigint") return `${value}n`;
  return value;
}

export function logActivity(event: string, details: Record<string, unknown> = {}): void {
  const loggingSetting = process.env.ACTIVITY_LOGGING?.trim().toLowerCase();
  if (loggingSetting === "false" || loggingSetting === "0" || loggingSetting === "off") return;

  try {
    const entry = {
      level: "info",
      time: new Date().toISOString(),
      component: "agentbridge.activity",
      event,
      details: redactForLog(details)
    };
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({
      level: "error",
      time: new Date().toISOString(),
      component: "agentbridge.activity",
      event: "activity_log.serialization_failed",
      details: { sourceEvent: event, message: redactSensitiveText(message) }
    })}\n`);
  }
}
