import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HomeAssistantApi, toHomeAssistantStates } from "./ha-api.js";

const entityIdSchema = z.string().max(255).regex(/^[a-z0-9_]+\.[a-z0-9_]+$/i);
const optionalDateTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Must be a valid date/time").optional();
const entityIdListSchema = z.string().max(500).refine(
  (value) => value.split(",").every((entityId) => entityIdSchema.safeParse(entityId.trim()).success),
  "Must contain one or more valid entity IDs"
).optional();
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
const serviceCallAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function formatToolResult(value: unknown): { content: [{ type: "text"; text: string }] } {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }]
  };
}

function formatToolError(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  return {
    isError: true,
    content: [{
      type: "text",
      text: error instanceof Error ? error.message : String(error)
    }]
  };
}

async function main(): Promise<void> {
  const api = new HomeAssistantApi(
    requiredEnvironmentValue("HA_BASE_URL"),
    requiredEnvironmentValue("HA_TOKEN")
  );
  const server = new McpServer({ name: "agentbridge-homeassistant", version: "1.0.0" });

  server.registerTool("ha_check_api", {
    description: "Check whether the Home Assistant REST API is available.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, async () => {
    try {
      return formatToolResult(await api.getApiStatus());
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_get_config", {
    description: "Get Home Assistant configuration, including timezone, version, and measurement units.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, async () => {
    try {
      return formatToolResult(await api.getConfig());
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_get_components", {
    description: "List loaded Home Assistant integrations and components.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, async () => {
    try {
      return formatToolResult(await api.getComponents());
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_get_states", {
    description: "List Home Assistant entity states, with optional domain and name/ID filters.",
    inputSchema: {
      domain: z.string().regex(/^[a-z0-9_]+$/i).optional(),
      search: z.string().max(200).optional()
    },
    annotations: readOnlyAnnotations
  }, async ({ domain, search }) => {
    try {
      const states = toHomeAssistantStates(await api.getStates());
      const normalizedDomain = domain?.toLowerCase();
      const normalizedSearch = search?.toLowerCase();
      const filtered = states
        .filter((state) => !normalizedDomain || state.entity_id.toLowerCase().startsWith(`${normalizedDomain}.`))
        .filter((state) => {
          if (!normalizedSearch) return true;
          const friendlyName = state.attributes.friendly_name;
          return state.entity_id.toLowerCase().includes(normalizedSearch)
            || (typeof friendlyName === "string" && friendlyName.toLowerCase().includes(normalizedSearch));
        })
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
      const maxResults = 500;
      return formatToolResult({
        count: Math.min(filtered.length, maxResults),
        total_entities: states.length,
        matching_entities: filtered.length,
        truncated: filtered.length > maxResults,
        filters: { domain: domain ?? null, search: search ?? null },
        entities: filtered.slice(0, maxResults).map(({ entity_id, state, attributes, last_changed }) => ({
          entity_id,
          state,
          friendly_name: attributes.friendly_name,
          ...(last_changed ? { last_changed } : {})
        }))
      });
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_get_state", {
    description: "Get current state and attributes for one Home Assistant entity.",
    inputSchema: { entity_id: entityIdSchema },
    annotations: readOnlyAnnotations
  }, async ({ entity_id }) => {
    try {
      return formatToolResult(await api.getState(entity_id));
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_get_services", {
    description: "List Home Assistant service domains and available services without invoking them.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, async () => {
    try {
      return formatToolResult(await api.getServices());
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_call_service", {
    description: "Immediately call a Home Assistant domain service without an approval prompt. Use only the service and target the user requested; provide entity_id, device_id, or area_id in service_data when applicable.",
    inputSchema: {
      domain: z.string().regex(/^[a-z0-9_]+$/i),
      service: z.string().regex(/^[a-z0-9_]+$/i),
      service_data: z.record(z.string(), z.unknown()).default({})
    },
    annotations: serviceCallAnnotations
  }, async ({ domain, service, service_data }) => {
    try {
      return formatToolResult(await api.callService(domain, service, service_data));
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_get_events", {
    description: "List Home Assistant event types without firing any events.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, async () => {
    try {
      return formatToolResult(await api.getEvents());
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_get_history", {
    description: "Read Home Assistant entity history over an optional time range.",
    inputSchema: {
      timestamp: optionalDateTime,
      end_time: optionalDateTime,
      entity_id: entityIdListSchema,
      minimal_response: z.boolean().optional()
    },
    annotations: readOnlyAnnotations
  }, async ({ timestamp, end_time, entity_id, minimal_response }) => {
    try {
      return formatToolResult(await api.getHistory({
        ...(timestamp ? { timestamp } : {}),
        ...(end_time ? { end_time } : {}),
        ...(entity_id ? { entity_id } : {}),
        ...(minimal_response !== undefined ? { minimal_response } : {})
      }));
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_get_logbook", {
    description: "Read Home Assistant logbook entries over an optional time range.",
    inputSchema: {
      timestamp: optionalDateTime,
      end_time: optionalDateTime,
      entity_id: entityIdSchema.optional()
    },
    annotations: readOnlyAnnotations
  }, async ({ timestamp, end_time, entity_id }) => {
    try {
      return formatToolResult(await api.getLogbook({
        ...(timestamp ? { timestamp } : {}),
        ...(end_time ? { end_time } : {}),
        ...(entity_id ? { entity_id } : {})
      }));
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_get_error_log", {
    description: "Read the Home Assistant error log.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, async () => {
    try {
      return formatToolResult(await api.getErrorLog());
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_get_calendars", {
    description: "List Home Assistant calendar entities.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, async () => {
    try {
      return formatToolResult(await api.getCalendars());
    } catch (error) {
      return formatToolError(error);
    }
  });

  server.registerTool("ha_get_calendar_events", {
    description: "Read events from one Home Assistant calendar for the requested time range.",
    inputSchema: {
      calendar_entity_id: entityIdSchema,
      start: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Must be a valid date/time"),
      end: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Must be a valid date/time")
    },
    annotations: readOnlyAnnotations
  }, async ({ calendar_entity_id, start, end }) => {
    try {
      if (Date.parse(start) >= Date.parse(end)) throw new Error("Calendar start must be earlier than end");
      return formatToolResult(await api.getCalendarEvents(calendar_entity_id, start, end));
    } catch (error) {
      return formatToolError(error);
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error("AgentBridge Home Assistant MCP server failed to start:", error);
  process.exitCode = 1;
});
