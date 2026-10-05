import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist/bin/az-axi.js");
const LOADER = join(ROOT, "test/fixtures/import-log-loader.mjs");

const HEAVY = [
  "axi-sdk-js",
  "@toon-format/toon",
  "../lib/router.js",
  "../lib/registry.js",
  "../lib/execute.js",
  "../help.js",
];

function pkgVersion(): string {
  return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
}

function run(args: string[], env: Record<string, string> = {}, nodeArgs: string[] = []) {
  return spawnSync(process.execPath, [...nodeArgs, BIN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("version fast path", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it.each(["--version", "-v", "-V"])("prints the package.json version for %s and exits 0", (flag) => {
    const result = run([flag]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${pkgVersion()}\n`);
    expect(result.stderr).toBe("");
  });

  it("answers without config or network", () => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-version-"));
    const stub = "globalThis.fetch=async()=>{throw new Error('network must not be used')}";
    const result = run(["--version"],
      { AZ_AXI_CONFIG: join(dir, "missing.json") },
      ["--import", `data:text/javascript,${encodeURIComponent(stub)}`]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${pkgVersion()}\n`);
  });

  it("does not import the command catalogue", () => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-version-"));
    const log = join(dir, "imports.log");
    const result = run(["--version"],
      { AZ_AXI_IMPORT_LOG: log },
      ["--no-warnings", "--loader", LOADER]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${pkgVersion()}\n`);
    const seen = readFileSync(log, "utf8").split("\n").filter(Boolean);
    for (const heavy of HEAVY) expect(seen, `must not import ${heavy}`).not.toContain(heavy);
    expect(seen).toContain("axi-sdk-js/fast-path");
  });
});
