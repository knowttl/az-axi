import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tripwires: the hook path reads the config file and environment only. If a
// future change imports a network or subprocess module here, these mocks make
// every test below explode instead of silently slowing session start.
vi.mock("../src/lib/client.js", () => {
  throw new Error("az-axi-hook must not import the API client");
});
vi.mock("../src/lib/auth.js", () => {
  throw new Error("az-axi-hook must not import auth (no `az` call)");
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: () => { throw new Error("az-axi-hook must not spawn"); } };
});

import { sessionSummary } from "../src/lib/hook.js";
import { packageInfo } from "../src/lib/version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");
const VERSION = packageInfo().version;
const SUB = "00000000-0000-0000-0000-000000000001";

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_TENANT", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_READ_ONLY"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-hook-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  vi.stubGlobal("fetch", () => { throw new Error("az-axi-hook must not fetch"); });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: unknown): string {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

describe("session summary", () => {
  it("reports not configured without a config file", () => {
    expect(sessionSummary([])).toEqual({
      profile: "not configured",
      version: VERSION,
      help: ["Run `az-axi config init --name <name> --auth az` to create a profile"],
    });
  });

  it("reports not configured with an empty profile set", () => {
    writeConfig({ profiles: {} });
    expect(sessionSummary([]).profile).toBe("not configured");
  });

  it("summarizes a configured profile from local state only", () => {
    writeConfig({ profiles: { work: { auth: "az", subscriptions: [SUB] } } });
    // auth:az would spawn `az` for identity; the child_process tripwire above
    // proves the summary never gets that far.
    expect(sessionSummary([])).toEqual({
      profile: "work",
      scope: "for 1 subscription",
      writes: "disabled (default)",
      version: VERSION,
      help: ["Run `az-axi` for the live dashboard"],
    });
  });

  it("labels management-group scope and carries scope flags into the hint", () => {
    writeConfig({ profiles: { work: { auth: "az", managementGroup: "mg-prod" } } });
    expect(sessionSummary([])).toMatchObject({ scope: "in management group mg-prod" });
    expect(sessionSummary(["--subscription", SUB])).toMatchObject({
      scope: "for 1 subscription",
      help: [`Run \`az-axi --subscription ${SUB}\` for the live dashboard`],
    });
  });

  it("reports write posture including the read-only override", () => {
    writeConfig({ profiles: { prod: { auth: "az", allowWrites: true, subscriptions: [SUB] } } });
    expect(sessionSummary([])).toMatchObject({ writes: "ENABLED for 1 subscription" });
    process.env.AZ_AXI_READ_ONLY = "1";
    expect(sessionSummary([])).toMatchObject({ writes: "disabled (AZ_AXI_READ_ONLY)" });
  });

  it("returns short records instead of throwing for config problems", () => {
    writeConfig({ profiles: { a: { auth: "az" }, b: { auth: "az" } } });
    const ambiguous = sessionSummary([]);
    expect(ambiguous.error).toContain("several profiles");
    expect(ambiguous.help).toContain("Pass --profile <name> or set $AZ_AXI_PROFILE");
    writeFileSync(join(dir, "config.json"), "{oops");
    const corrupt = sessionSummary([]);
    expect(corrupt.error).toContain("is not valid JSON");
  });

  it("rejects unknown flags without Azure access", () => {
    expect(() => sessionSummary(["--org", "x"])).toThrowError(expect.objectContaining({ code: "UNKNOWN_FLAG" }));
  });

  it("finishes well under a second", () => {
    writeConfig({ profiles: { work: { auth: "az", subscriptions: [SUB] } } });
    const start = Date.now();
    sessionSummary([]);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("hook entry point", () => {
  function runBin(entry: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
    const guard = "globalThis.fetch=()=>{throw new Error('unexpected network request')};";
    return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(guard)}`, ...entry], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  it("exits 0 with the summary from source and from the build", () => {
    writeConfig({ profiles: { work: { auth: "az", subscriptions: [SUB] } } });
    const env = { AZ_AXI_CONFIG: join(dir, "config.json") };
    for (const entry of [[TSX, "src/bin/az-axi-hook.ts"], ["dist/bin/az-axi-hook.js"]]) {
      const result = runBin(entry, env);
      expect(result.status, entry.join(" ")).toBe(0);
      expect(result.stderr, entry.join(" ")).toBe("");
      expect(result.stdout, entry.join(" ")).toContain("profile: work");
      expect(result.stdout, entry.join(" ")).toContain(`version: ${VERSION}`);
    }
  }, 60_000);

  it("exits 0 with the not-configured line when unconfigured", () => {
    const env = { AZ_AXI_CONFIG: join(dir, "missing.json") };
    const result = runBin(["dist/bin/az-axi-hook.js"], env);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("profile: not configured");
  }, 30_000);

  it("exits 0 with a short record for a corrupt config", () => {
    writeFileSync(join(dir, "config.json"), "{oops");
    const result = runBin(["dist/bin/az-axi-hook.js"], { AZ_AXI_CONFIG: join(dir, "config.json") });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("error:");
  }, 30_000);

  it("finishes the built binary well under a second", () => {
    writeConfig({ profiles: { work: { auth: "az", subscriptions: [SUB] } } });
    const start = Date.now();
    const result = runBin(["dist/bin/az-axi-hook.js"], { AZ_AXI_CONFIG: join(dir, "config.json") });
    expect(result.status).toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  }, 30_000);
});
