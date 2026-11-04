import type { PermissionRequest } from "@github/copilot-sdk";

const autoApprovedReadOnlyTools: ReadonlySet<string> = new Set([
  "mcp:homeassistant-ha_check_api",
  "mcp:homeassistant-ha_get_config",
  "mcp:homeassistant-ha_get_components",
  "mcp:homeassistant-ha_get_states",
  "mcp:homeassistant-ha_get_state",
  "mcp:homeassistant-ha_get_services",
  "mcp:homeassistant-ha_get_events",
  "mcp:homeassistant-ha_get_history",
  "mcp:homeassistant-ha_get_logbook",
  "mcp:homeassistant-ha_get_error_log",
  "mcp:homeassistant-ha_get_calendars",
  "mcp:homeassistant-ha_get_calendar_events"
]);
const autoApprovedServiceTools: ReadonlySet<string> = new Set([
  "mcp:homeassistant-ha_call_service"
]);

export function resolveConfiguredMcpToolId(
  request: PermissionRequest,
  configuredTools: readonly string[]
): string | undefined {
  if (request.kind !== "mcp") return undefined;
  const serverName = request.serverName.replace(/^mcp:/, "");
  const requestedToolName = request.toolName.replace(/^mcp:/, "");
  const serverPrefix = `${serverName}-`;
  const unqualifiedToolName = requestedToolName.startsWith(serverPrefix)
    ? requestedToolName.slice(serverPrefix.length)
    : requestedToolName;
  const toolNames = new Set([requestedToolName, unqualifiedToolName]);
  const configuredPrefix = `mcp:${serverName}-`;

  return configuredTools.find((toolId) =>
    toolId.startsWith(configuredPrefix) && toolNames.has(toolId.slice(configuredPrefix.length))
  );
}

export function isAutoApprovedMcpOperation(
  request: PermissionRequest,
  configuredTools: readonly string[]
): boolean {
  if (request.kind !== "mcp") return false;
  const toolId = resolveConfiguredMcpToolId(request, configuredTools);
  if (!toolId) return false;
  return (request.readOnly === true && autoApprovedReadOnlyTools.has(toolId))
    || (request.readOnly === false && autoApprovedServiceTools.has(toolId));
}
