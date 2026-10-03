#!/usr/bin/env node
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify(args) + "\n");
const env = Object.fromEntries([
  "AZURE_CONFIG_DIR", "AZURE_EXTENSION_DIR", "AZURE_EXTENSION_SYS_DIR", "AZURE_EXTENSION_DEV_SOURCES",
  "AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "AZURE_CORE_OUTPUT", "AZURE_CORE_COLLECT_TELEMETRY",
  "AZURE_CORE_ONLY_SHOW_ERRORS", "AZURE_CORE_DISABLE_CONFIRM_PROMPT", "AZURE_AUTO-UPGRADE_ENABLE", "AZURE_LOGGING_ENABLE_LOG_FILE",
].map((key) => [key, process.env[key]]));
appendFileSync(join(dir, "envs.jsonl"), JSON.stringify({ ...env, extensionFiles: readdirSync(env.AZURE_EXTENSION_DIR) }) + "\n");
const responses = JSON.parse(readFileSync(join(dir, "responses.json"), "utf8"));
const key = args[0] === "version" ? "version" : args.slice(0, 2).join(" ");
if (responses.fail === key) {
  process.stderr.write("raw dependency diagnostic with secret-token");
  process.exit(1);
}
const response = responses[key];
if (response === undefined) process.exit(9);
process.stdout.write(typeof response === "string" ? response : JSON.stringify(response));
