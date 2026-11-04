import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { automationScript, powershellExecutable } from "./ui-adapter.js";

const mode = process.argv[2];
if (!["bind", "inspect", "probe"].includes(mode || "")) {
  throw new Error("Usage: tsx src\\ui-cli.ts bind|inspect|probe [--pid PROCESS_ID]");
}
const pidIndex = process.argv.indexOf("--pid");
const pid = pidIndex >= 0 ? process.argv[pidIndex + 1] : undefined;
if (pidIndex >= 0 && (!pid || !/^[1-9]\d*$/.test(pid))) throw new Error("--pid requires a Windows process ID.");
const args = [
  "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
  "-File", automationScript,
  "-TargetFile", path.resolve(process.env.UI_TARGET_FILE || ".data\\ui-target.json"),
  `-${mode}`
];
if (pid) args.push("-WindowProcessId", pid);
const child = spawn(powershellExecutable, args, { stdio: "inherit" });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
