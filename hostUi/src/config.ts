import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

export interface RuntimeConfig {
  bind: string;
  port: number;
  tlsCertPath: string;
  tlsKeyPath: string;
  dataDirectory: string;
  openAiApiKey?: string;
  sttModel: string;
  ttsModel: string;
  summaryModel: string;
}

export function validateBindAddress(bind: string): string {
  if (bind === "localhost") return "127.0.0.1";
  if (isIP(bind) === 4) {
    const [a, b] = bind.split(".").map(Number);
    if (a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254)) return bind;
  }
  if (isIP(bind) === 6) {
    const value = bind.toLowerCase();
    if (value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return bind;
  }
  throw new Error("HOST_UI_BIND must be a concrete loopback or private IP address");
}

export function loadConfig(): RuntimeConfig {
  const port = Number(process.env.HOST_UI_PORT || "8444");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("HOST_UI_PORT must be between 1 and 65535");
  const openAiApiKey = process.env.HOST_UI_OPENAI_API_KEY?.trim();
  const dataDirectory = path.resolve(process.env.HOST_UI_DATA_DIR || "./.data");
  const originalHost = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "host").toLowerCase();
  const normalizedData = dataDirectory.toLowerCase();
  if (normalizedData === originalHost || normalizedData.startsWith(originalHost + path.sep)) {
    throw new Error("HOST_UI_DATA_DIR must not reuse the original host directory");
  }
  return {
    bind: validateBindAddress(process.env.HOST_UI_BIND?.trim() || "127.0.0.1"),
    port,
    dataDirectory,
    tlsCertPath: path.resolve(process.env.HOST_UI_TLS_CERT_PATH || "./certs/host.crt"),
    tlsKeyPath: path.resolve(process.env.HOST_UI_TLS_KEY_PATH || "./certs/host.key"),
    ...(openAiApiKey ? { openAiApiKey } : {}),
    sttModel: process.env.HOST_UI_OPENAI_STT_MODEL?.trim() || "gpt-4o-mini-transcribe",
    ttsModel: process.env.HOST_UI_OPENAI_TTS_MODEL?.trim() || "tts-1",
    summaryModel: process.env.HOST_UI_OPENAI_SUMMARY_MODEL?.trim() || "gpt-4o-mini"
  };
}
