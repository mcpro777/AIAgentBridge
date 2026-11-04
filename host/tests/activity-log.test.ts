import { describe, expect, it } from "vitest";
import { redactForLog, redactSensitiveText } from "../src/activity-log.js";

describe("activity log redaction", () => {
  it("redacts credential fields and recognizable token formats", () => {
    const result = redactForLog({
      authorization: "Bearer sensitive-value",
      nested: {
        ha_token: "home-assistant-token",
        prompt: "Use this github_pat_0123456789abcdefghijklmnopqrstuv and Bearer abc.def"
      },
      message: "Normal diagnostic text"
    });

    expect(result).toEqual({
      authorization: "[REDACTED]",
      nested: {
        ha_token: "[REDACTED]",
        prompt: "Use this [REDACTED TOKEN] and Bearer [REDACTED]"
      },
      message: "Normal diagnostic text"
    });
  });

  it("redacts secret assignments and private key blocks in file contents", () => {
    const content = [
      "api_password: a value with spaces",
      "\"access_token\": \"sample-token\",",
      "-----BEGIN PRIVATE KEY-----",
      "sample-private-key",
      "-----END PRIVATE KEY-----"
    ].join("\n");

    const redacted = redactSensitiveText(content);

    expect(redacted).not.toContain("a value with spaces");
    expect(redacted).not.toContain("sample-token");
    expect(redacted).not.toContain("sample-private-key");
    expect(redacted).toContain("[REDACTED PRIVATE KEY]");
  });
});
