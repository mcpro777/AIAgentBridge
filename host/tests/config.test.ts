import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadMcpConfig, validateBindAddress } from "../src/config.js";

afterEach(() => vi.unstubAllEnvs());

describe("private listener binding", () => {
  it("permits loopback, private LAN, and VPN addresses only", () => {
    expect(validateBindAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(validateBindAddress("192.168.1.20")).toBe("192.168.1.20");
    expect(validateBindAddress("100.64.2.3")).toBe("100.64.2.3");
    expect(() => validateBindAddress("0.0.0.0")).toThrow();
    expect(() => validateBindAddress("8.8.8.8")).toThrow();
  });
});

describe("spoken summary model configuration", () => {
  it("defaults the optional model and honors an explicit model", () => {
    vi.stubEnv("OPENAI_SUMMARY_MODEL", "");
    expect(loadConfig().summaryModel).toBe("gpt-4o-mini");
    vi.stubEnv("OPENAI_SUMMARY_MODEL", "test-summary-model");
    expect(loadConfig().summaryModel).toBe("test-summary-model");
  });
});

describe("MCP configuration", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("limits exposed tools to explicitly listed names", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agentbridge-config-"));
    const filename = path.join(directory, "mcp.json");
    await writeFile(filename, JSON.stringify({
      servers: [{
        name: "homeassistant",
        type: "stdio",
        command: "C:\\tools\\ha-mcp.exe",
        tools: ["get_state", "call_service"],
        env: {}
      }]
    }));

    const config = await loadMcpConfig(filename);
    expect(config.availableTools).toEqual([
      "mcp:homeassistant-get_state",
      "mcp:homeassistant-call_service"
    ]);
    expect(config.servers.homeassistant).toMatchObject({ tools: ["get_state", "call_service"] });
  });

  it("resolves MCP environment references without putting their values in the config file", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agentbridge-config-"));
    const filename = path.join(directory, "mcp.json");
    const variableName = "AGENTBRIDGE_TEST_HA_TOKEN";
    const previousValue = process.env[variableName];
    process.env[variableName] = "test-token-value";
    try {
      await writeFile(filename, JSON.stringify({
        servers: [{
          name: "homeassistant",
          type: "stdio",
          command: "C:\\tools\\node.exe",
          args: ["server.js"],
          tools: ["ha_get_states"],
          env: { HA_TOKEN: `\${${variableName}}` }
        }]
      }));

      const config = await loadMcpConfig(filename);
      expect(config.servers.homeassistant).toMatchObject({ env: { HA_TOKEN: "test-token-value" } });
    } finally {
      if (previousValue === undefined) delete process.env[variableName];
      else process.env[variableName] = previousValue;
    }
  });

  it("fails explicitly when an MCP environment reference is missing", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agentbridge-config-"));
    const filename = path.join(directory, "mcp.json");
    const variableName = "AGENTBRIDGE_TEST_MISSING_HA_TOKEN";
    const previousValue = process.env[variableName];
    delete process.env[variableName];
    try {
      await writeFile(filename, JSON.stringify({
        servers: [{
          name: "homeassistant",
          type: "stdio",
          command: "C:\\tools\\node.exe",
          tools: ["ha_get_states"],
          env: { HA_TOKEN: `\${${variableName}}` }
        }]
      }));

      await expect(loadMcpConfig(filename)).rejects.toThrow(`requires environment variable ${variableName}`);
    } finally {
      if (previousValue !== undefined) process.env[variableName] = previousValue;
    }
  });

  it("preserves special object-key MCP names without prototype collisions", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agentbridge-config-"));
    const filename = path.join(directory, "mcp.json");
    await writeFile(filename, JSON.stringify({
      servers: [{
        name: "__proto__",
        type: "stdio",
        command: "C:\\tools\\custom-mcp.exe",
        tools: ["read"],
        env: {}
      }]
    }));

    const config = await loadMcpConfig(filename);
    expect(config.availableTools).toEqual(["mcp:__proto__-read"]);
    expect(Object.keys(config.servers)).toEqual(["__proto__"]);
  });

  it("rejects wildcard tool lists", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agentbridge-config-"));
    const filename = path.join(directory, "mcp.json");
    await writeFile(filename, JSON.stringify({
      servers: [{
        name: "remote",
        type: "http",
        url: "https://192.168.1.10/mcp",
        tools: ["*"]
      }]
    }));

    await expect(loadMcpConfig(filename)).rejects.toThrow();
  });

  it("rejects unencrypted remote MCP URLs", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agentbridge-config-"));
    const filename = path.join(directory, "mcp.json");
    await writeFile(filename, JSON.stringify({
      servers: [{
        name: "remote",
        type: "http",
        url: "http://192.168.1.10/mcp",
        tools: ["get_state"]
      }]
    }));

    await expect(loadMcpConfig(filename)).rejects.toThrow();
  });
});
