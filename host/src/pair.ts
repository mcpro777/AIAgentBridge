import "dotenv/config";
import path from "node:path";
import { loadConfig } from "./config.js";
import { BridgeStore } from "./store.js";

const config = loadConfig();
const store = new BridgeStore(path.join(config.dataDirectory, "agentbridge.sqlite"));
const code = store.createPairingCode();
console.info(`Pairing code (valid for 5 minutes, single use): ${code}`);
store.close();
