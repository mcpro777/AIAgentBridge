import "dotenv/config";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CopilotService } from "./copilot.js";
import { loadConfig, loadMcpConfig } from "./config.js";
import { createServer } from "./server.js";
import { BridgeStore } from "./store.js";
import { logActivity } from "./activity-log.js";

const config = loadConfig();
config.filesystemRoots = await Promise.all(config.filesystemRoots.map(async (root) => {
  const resolved = await realpath(root);
  if (!(await stat(resolved)).isDirectory()) throw new Error(`FILESYSTEM_ROOTS entry is not a directory: ${root}`);
  return resolved;
}));
const [certificate, privateKey] = await Promise.all([
  readFile(config.tlsCertPath),
  readFile(config.tlsKeyPath)
]);
const mcpConfig = await loadMcpConfig(config.mcpConfigPath);
logActivity("mcp.config.loaded", {
  path: config.mcpConfigPath,
  servers: Object.keys(mcpConfig.servers),
  availableTools: mcpConfig.availableTools
});
const store = new BridgeStore(path.join(config.dataDirectory, "agentbridge.sqlite"));
const copilot = new CopilotService(config, mcpConfig, store, () => undefined);
let app: ReturnType<typeof createServer> | undefined;
let copilotStarted = false;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`AgentBridge shutting down (${signal})`);
  await closeResources();
}

async function closeResources(): Promise<void> {
  const failures: unknown[] = [];
  if (app) {
    try {
      await app.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (copilotStarted) {
    try {
      await copilot.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    store.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    console.error("AgentBridge shutdown failed", new AggregateError(failures));
    process.exitCode = 1;
  }
}

try {
  await copilot.start();
  copilotStarted = true;
  const server = createServer(config, store, copilot, { key: privateKey, cert: certificate });
  app = server;
  await server.listen({ host: config.bind, port: config.port });
  console.info(`AgentBridge listening with HTTPS on ${config.bind}:${config.port}`);
} catch (error) {
  await closeResources();
  throw error;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
