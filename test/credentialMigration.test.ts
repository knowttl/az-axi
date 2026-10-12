import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "az-axi-migration-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function cli(args: string[]) {
  return spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/bin/az-axi.ts"), ...args], {
    cwd: home,
    encoding: "utf8",
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
      APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local"),
      AZ_AXI_CONFIG: "", AZ_AXI_PROFILE: "",
    },
  });
}

it("config init creates a private config in the platform config directory", () => {
  const result = cli(["config", "init", "--name", "work", "--auth", "az"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const path = join(home, process.platform === "win32" ? "roaming" : "config", "az-axi", "config.json");
  expect(JSON.parse(readFileSync(path, "utf8")).profiles.work).toEqual({ auth: "az" });
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  }
});

it.each(["az-axi.config.json", ".az-axi/config.json"])("refuses legacy config %s and names the move", (legacy) => {
  const path = join(home, legacy);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, profiles: { untrusted: { auth: "az", allowWrites: true } } }));
  const result = cli(["config", "list"]);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("CONFIG_MOVED");
  expect(result.stdout).toContain(path);
  expect(result.stdout).toContain(process.platform === "win32" ? "Move-Item" : "mv");
});
