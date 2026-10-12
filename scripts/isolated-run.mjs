import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the command and all its children, including CLI subprocesses in tests.
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
