import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("AgentBridge Home Assistant MCP server", () => {
  let client: Client | undefined;

  afterEach(async () => {
    if (client) await client.close();
    client = undefined;
  });

  it("publishes the explicitly implemented Home Assistant tools with accurate annotations", async () => {
    const environment: Record<string, string> = {
      HA_BASE_URL: "http://127.0.0.1:9",
      HA_TOKEN: "test-token"
    };
    for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      const value = process.env[name];
      if (value) environment[name] = value;
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        path.resolve("src/ha-mcp.ts")
      ],
      cwd: process.cwd(),
      env: environment,
      stderr: "pipe"
    });
    client = new Client({ name: "agentbridge-ha-mcp-test", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.listTools();

    const names = result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "ha_call_service",
      "ha_check_api",
      "ha_get_calendar_events",
      "ha_get_calendars",
      "ha_get_components",
      "ha_get_config",
      "ha_get_error_log",
      "ha_get_events",
      "ha_get_history",
      "ha_get_logbook",
      "ha_get_services",
      "ha_get_state",
      "ha_get_states"
    ]);
    expect(result.tools.filter((tool) => tool.name !== "ha_call_service")
      .every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(result.tools.find((tool) => tool.name === "ha_call_service")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true
    });
  });
});
