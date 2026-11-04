import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

afterEach(() => vi.unstubAllEnvs());
describe("independent host configuration", () => {
  it("defaults to its own port and does not inherit host voice credentials", () => {
    vi.stubEnv("HOST_UI_PORT", "");
    vi.stubEnv("HOST_UI_BIND", "");
    vi.stubEnv("HOST_UI_DATA_DIR", "");
    vi.stubEnv("HOST_UI_OPENAI_API_KEY", "");
    vi.stubEnv("HOST_UI_OPENAI_SUMMARY_MODEL", "");
    vi.stubEnv("PORT", "8443");
    vi.stubEnv("OPENAI_API_KEY", "original-host-key");
    const config = loadConfig();
    expect(config.port).toBe(8444);
    expect(config.bind).toBe("127.0.0.1");
    expect(config.openAiApiKey).toBeUndefined();
    expect(config.summaryModel).toBe("gpt-4o-mini");
    expect(config.dataDirectory).toBe(path.resolve(".data"));
    vi.stubEnv("HOST_UI_OPENAI_API_KEY", "explicit-ui-key");
    expect(loadConfig().openAiApiKey).toBe("explicit-ui-key");
    vi.stubEnv("HOST_UI_OPENAI_SUMMARY_MODEL", "test-summary-model");
    expect(loadConfig().summaryModel).toBe("test-summary-model");
  });
  it("rejects original host data and invalid ports", () => {
    vi.stubEnv("HOST_UI_DATA_DIR", path.resolve("../host/.data"));
    expect(() => loadConfig()).toThrow("original host");
    vi.stubEnv("HOST_UI_DATA_DIR", "");
    vi.stubEnv("HOST_UI_PORT", "0");
    expect(() => loadConfig()).toThrow("between 1 and 65535");
  });
});
