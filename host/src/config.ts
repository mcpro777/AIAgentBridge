import { readFile } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import type { MCPServerConfig } from "@github/copilot-sdk";

const mcpServerSchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    workingDirectory: z.string().optional(),
    tools: z.array(z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/)).min(1),
    env: z.record(z.string(), z.string()).default({})
  }).strict(),
  z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    type: z.enum(["http", "sse"]),
    url: z.url().refine((value) => new URL(value).protocol === "https:", "Remote MCP servers must use HTTPS"),
    tools: z.array(z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/)).min(1),
    headers: z.record(z.string(), z.string()).default({})
  }).strict()
]);

const mcpConfigSchema = z.object({
  servers: z.array(mcpServerSchema).default([])
}).strict();

export interface RuntimeConfig {
  bind: string;
  port: number;
  tlsCertPath: string;
  tlsKeyPath: string;
  dataDirectory: string;
  mcpConfigPath: string;
  filesystemRoots: string[];
  githubToken?: string;
  openAiApiKey?: string;
  sttModel: string;
  ttsModel: string;
  summaryModel: string;
}

export interface LoadedMcpConfig {
  servers: Record<string, MCPServerConfig>;
  availableTools: string[];
}

export function validateBindAddress(bind: string): string {
  if (bind === "localhost") return "127.0.0.1";
  const version = isIP(bind);
  if (version === 4) {
    const octets = bind.split(".").map(Number);
    const [a, b] = octets;
    const isLoopback = a === 127;
    const isPrivate = a === 10
      || (a === 172 && b !== undefined && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b !== undefined && b >= 64 && b <= 127)
      || (a === 169 && b === 254);
    if (!isLoopback && !isPrivate) throw new Error("HOST_BIND must be a loopback or private IPv4 address");
    return bind;
  }
  if (version === 6) {
    const normalized = bind.toLowerCase();
    if (normalized === "::1" || normalized.startsWith("fd") || normalized.startsWith("fc") || normalized.startsWith("fe80:")) return bind;
    throw new Error("HOST_BIND must be a loopback, ULA, or link-local IPv6 address");
  }
  throw new Error("HOST_BIND must be a concrete loopback or private IP address");
}

function optionalEnvironmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveMcpEnvironment(serverName: string, environment: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(environment)) {
    const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (!reference) {
      resolved[name] = value;
      continue;
    }
    const variableName = reference[1];
    const variableValue = variableName ? process.env[variableName] : undefined;
    if (!variableValue) throw new Error(`MCP server "${serverName}" requires environment variable ${variableName}`);
    resolved[name] = variableValue;
  }
  return resolved;
}

export function loadConfig(): RuntimeConfig {
  const bind = validateBindAddress(process.env.HOST_BIND?.trim() || "127.0.0.1");
  const port = Number(process.env.PORT || "8443");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  const filesystemRootValues = (process.env.FILESYSTEM_ROOTS || "").split(";").map((root) => root.trim()).filter(Boolean);
  if (filesystemRootValues.some((root) => !path.isAbsolute(root))) {
    throw new Error("Every FILESYSTEM_ROOTS entry must be an absolute path");
  }
  const githubToken = optionalEnvironmentValue("COPILOT_GITHUB_TOKEN");
  const openAiApiKey = optionalEnvironmentValue("OPENAI_API_KEY");
  return {
    bind,
    port,
    tlsCertPath: path.resolve(process.env.TLS_CERT_PATH || "./certs/host.crt"),
    tlsKeyPath: path.resolve(process.env.TLS_KEY_PATH || "./certs/host.key"),
    dataDirectory: path.resolve(process.env.DATA_DIR || "./.data"),
    mcpConfigPath: path.resolve(process.env.MCP_CONFIG_PATH || "./mcp-servers.json"),
    filesystemRoots: filesystemRootValues.map((root) => path.resolve(root)),
    ...(githubToken ? { githubToken } : {}),
    ...(openAiApiKey ? { openAiApiKey } : {}),
    sttModel: process.env.OPENAI_STT_MODEL?.trim() || "gpt-4o-mini-transcribe",
    ttsModel: process.env.OPENAI_TTS_MODEL?.trim() || "tts-1",
    summaryModel: process.env.OPENAI_SUMMARY_MODEL?.trim() || "gpt-4o-mini"
  };
}

export async function loadMcpConfig(filePath: string): Promise<LoadedMcpConfig> {
  let parsed: unknown = { servers: [] };
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const config = mcpConfigSchema.parse(parsed);
  const servers = Object.create(null) as Record<string, MCPServerConfig>;
  const serverNames = new Set<string>();
  const allowedToolNames = new Set<string>();
  const availableTools: string[] = [];
  for (const entry of config.servers) {
    if (serverNames.has(entry.name)) throw new Error(`Duplicate MCP server name: ${entry.name}`);
    serverNames.add(entry.name);
    for (const toolName of entry.tools) {
      const allowedTool = `mcp:${entry.name}-${toolName}`;
      if (allowedToolNames.has(allowedTool)) throw new Error(`Duplicate MCP tool identifier: ${allowedTool}`);
      allowedToolNames.add(allowedTool);
      availableTools.push(allowedTool);
    }
    if (entry.type === "stdio") {
      if (!path.isAbsolute(entry.command)) throw new Error(`MCP server "${entry.name}" command must be an absolute path`);
      servers[entry.name] = {
        type: "stdio",
        command: entry.command,
        args: entry.args,
        tools: entry.tools,
        ...(entry.workingDirectory ? { workingDirectory: path.resolve(entry.workingDirectory) } : {}),
        env: resolveMcpEnvironment(entry.name, entry.env)
      };
    } else {
      servers[entry.name] = {
        type: entry.type,
        url: entry.url,
        tools: entry.tools,
        headers: entry.headers
      };
    }
  }
  return { servers, availableTools };
}
