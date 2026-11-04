import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@github/copilot-sdk";
import { isAutoApprovedMcpOperation, resolveConfiguredMcpToolId } from "../src/mcp-policy.js";

function mcpRequest(
  serverName: string,
  toolName: string,
  readOnly: boolean
): PermissionRequest {
  return {
    kind: "mcp",
    serverName,
    toolName,
    toolTitle: toolName,
    readOnly,
    args: {}
  };
}

describe("MCP approval policy", () => {
  it("auto-approves configured read-only Home Assistant API tools", () => {
    const request = mcpRequest("homeassistant", "ha_get_states", true);
    expect(isAutoApprovedMcpOperation(request, ["mcp:homeassistant-ha_get_states"])).toBe(true);
  });

  it("matches either internal or canonical server-qualified MCP tool names", () => {
    const configured = ["mcp:homeassistant-ha_get_states"];
    expect(resolveConfiguredMcpToolId(
      mcpRequest("homeassistant", "homeassistant-ha_get_states", true),
      configured
    )).toBe(configured[0]);
    expect(isAutoApprovedMcpOperation(
      mcpRequest("mcp:homeassistant", "mcp:homeassistant-ha_get_states", true),
      configured
    )).toBe(true);
  });

  it("auto-approves the configured Home Assistant service-call tool", () => {
    expect(isAutoApprovedMcpOperation(
      mcpRequest("homeassistant", "ha_call_service", false),
      ["mcp:homeassistant-ha_call_service"]
    )).toBe(true);
  });

  it("keeps filesystem operations and unknown tools approval-gated", () => {
    expect(isAutoApprovedMcpOperation(
      mcpRequest("ha_files", "read_text_file", true),
      ["mcp:ha_files-read_text_file"]
    )).toBe(false);
    expect(isAutoApprovedMcpOperation(
      mcpRequest("ha_files", "write_file", false),
      ["mcp:ha_files-write_file"]
    )).toBe(false);
    expect(isAutoApprovedMcpOperation(
      mcpRequest("homeassistant", "unrecognized_read_tool", true),
      ["mcp:homeassistant-unrecognized_read_tool"]
    )).toBe(false);
    expect(isAutoApprovedMcpOperation(
      mcpRequest("homeassistant", "ha_call_service", true),
      ["mcp:homeassistant-ha_call_service"]
    )).toBe(false);
  });

  it("does not auto-approve a recognized tool unless it is configured", () => {
    expect(isAutoApprovedMcpOperation(
      mcpRequest("homeassistant", "ha_get_states", true),
      []
    )).toBe(false);
  });
});
