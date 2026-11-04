import "dotenv/config";
import path from "node:path";
import { loadConfig } from "./config.js";
import { BridgeStore } from "./store.js";

const store = new BridgeStore(path.join(loadConfig().dataDirectory, "agentbridge-ui.sqlite"));
try { console.info(`Pairing code (valid for 5 minutes, single use): ${store.createPairingCode()}`); }
finally { store.close(); }
