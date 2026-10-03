import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUB = "00000000-0000-0000-0000-000000000020";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-status-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ defaultProfile: "writer", profiles: {
    reader: { auth: "token", subscriptions: [SUB] }, writer: { auth: "token", allowWrites: true, subscriptions: [SUB] },
  } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(argv: string[], readOnly = "") {
  // This preload replaces fetch completely, with no network fallback; token auth never spawns az.
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(join(ROOT, "test/apiWritesPreload.mjs")).href,
    join(ROOT, "dist/bin/az-axi.js"), ...argv], { cwd: ROOT, encoding: "utf8", env: {
      ...process.env, AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_PROFILE: "", AZ_AXI_TENANT: "",
      AZ_AXI_SUBSCRIPTION: "", AZ_AXI_READ_ONLY: readOnly, AZ_AXI_ARM_TOKEN: "offline-status-token",
      AZ_AXI_LOGS_TOKEN: "offline-status-token", AZ_AXI_GRAPH_TOKEN: "offline-status-token",
      AZ_AXI_WRITE_LOG: join(dir, "writes.log"), AZ_AXI_TEST_REQUESTS: join(dir, "requests.jsonl"),
    } });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return decode(result.stdout) as Record<string, unknown>;
}

describe("built dashboard and doctor write status, offline only", () => {
  it.each(["", "1", "true", "0"])("shows the effective write status and immutable write scope with read-only=%s", (readOnly) => {
    const forced = readOnly === "1" || readOnly === "true";
    const home = cli(["home", "--subscription", "00000000-0000-0000-0000-000000000021"], readOnly);
    expect(home).toMatchObject({ writes: forced ? "disabled (AZ_AXI_READ_ONLY)" : "ENABLED for 1 subscription",
      writeSubscriptions: [SUB], readOnly: { set: true, forced }, writeLog: join(dir, "writes.log") });
    const doctor = cli(["doctor"], readOnly);
    expect(doctor).toMatchObject({ readOnly: { set: true, forced }, writeLog: join(dir, "writes.log") });
    expect(doctor.profiles).toEqual([
      expect.objectContaining({ name: "reader", writes: forced ? "disabled (AZ_AXI_READ_ONLY)" : "disabled (default)", writeSubscriptions: "(none)" }),
      expect.objectContaining({ name: "writer", writes: forced ? "disabled (AZ_AXI_READ_ONLY)" : "ENABLED for 1 subscription", writeSubscriptions: SUB }),
    ]);
    expect(JSON.stringify([home.help, doctor.help])).not.toContain("allowWrites");
  });
});
