import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the command and all its children, including CLI subprocesses in tests.
// Resolve cached install tools before isolating HOME; package tests never bootstrap Corepack.
const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
const corepack = process.env.COREPACK_HOME || join(cache, "node/corepack");
const { packageManager } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const pnpm = join(corepack, "v1/pnpm", packageManager.split("@")[1], "bin/pnpm.cjs");
const home = mkdtempSync(join(tmpdir(), "az-axi-validation-"));
if (process.platform !== "win32") process.umask(0o077);
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("Usage: node scripts/isolated-run.mjs <command> [args...]");
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      AZ_AXI_TEST_PNPM: process.env.AZ_AXI_TEST_PNPM || (existsSync(pnpm) ? pnpm : "pnpm"),
      AZ_AXI_TEST_PNPM_CACHE: process.env.AZ_AXI_TEST_PNPM_CACHE || join(cache, "pnpm"),
      COREPACK_ENABLE_NETWORK: "0",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      APPDATA: join(home, "AppData/Roaming"),
      LOCALAPPDATA: join(home, "AppData/Local"),
      AZURE_CONFIG_DIR: join(home, ".azure"),
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
