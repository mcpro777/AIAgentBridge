import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { BridgeStore } from "./store.js";
import { RelayService } from "./relay.js";
import { createServer } from "./server.js";
import { WindowsUiAdapter } from "./ui-adapter.js";

const config = loadConfig();
const [cert, key] = await Promise.all([readFile(config.tlsCertPath), readFile(config.tlsKeyPath)]);
const store = new BridgeStore(path.join(config.dataDirectory, "agentbridge-ui.sqlite"));
let relay: RelayService | undefined;
let app: ReturnType<typeof createServer> | undefined;
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  const failures: unknown[] = [];
  try {
    try { await relay?.stop(); } catch (error) { failures.push(error); }
    try { await app?.close(); } catch (error) { failures.push(error); }
  } finally { store.close(); }
  if (failures.length) throw new AggregateError(failures, "UI relay shutdown failed");
}
try {
  relay = new RelayService(new WindowsUiAdapter(), store);
  app = createServer(config, store, relay, { cert, key });
  await app.listen({ host: config.bind, port: config.port });
  console.info(`AgentBridge UI relay listening with HTTPS on ${config.bind}:${config.port}`);
  console.info("One live VS Code target. Approvals and unsupported interactions remain local.");
} catch (error) {
  await shutdown();
  throw error;
}
process.once("SIGINT", () => { void shutdown().catch((error: unknown) => { console.error(error); process.exitCode = 1; }); });
process.once("SIGTERM", () => { void shutdown().catch((error: unknown) => { console.error(error); process.exitCode = 1; }); });
