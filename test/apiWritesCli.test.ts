import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUB = "00000000-0000-0000-0000-000000000021";
const TARGET = `/subscriptions/${SUB}/resourceGroups/rg-demo`;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-execute-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
    reader: { auth: "token" }, writer: { auth: "token", allowWrites: true, subscriptions: [SUB] },
  } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(scenario: string, extra: string[] = [], profile = "writer", readOnly = "", method = "PATCH") {
  return spawnSync(process.execPath, ["--import", pathToFileURL(join(ROOT, "test/apiWritesPreload.mjs")).href,
    join(ROOT, "dist/bin/az-axi.js"), "api", method, TARGET, "--api-version", "1",
    "--body", '{"tags":{"env":"prod"}}', "--profile", profile,
    ...(extra.includes("--execute=false") ? [] : ["--execute"]), ...extra], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, AZ_AXI_CONFIG: join(dir, "config.json"),
      AZ_AXI_ARM_TOKEN: "offline-execute-test-token", AZ_AXI_PROFILE: "", AZ_AXI_TENANT: "",
      AZ_AXI_SUBSCRIPTION: "", AZ_AXI_READ_ONLY: readOnly, AZ_AXI_WRITE_LOG: join(dir, "writes.log"),
      AZ_AXI_TEST_OUTCOME: scenario, AZ_AXI_TEST_REQUESTS: join(dir, "requests.jsonl") },
  });
}

function requests(): Array<{ method: string; ifMatch?: string }> {
  const path = join(dir, "requests.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}
function entries(): Array<Record<string, unknown>> {
  const path = join(dir, "writes.log");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

describe("built API CLI, offline only", () => {
  it.each(["sync", "created", "async", "location", "no-wait"])("executes %s and appends exactly one metadata-only log entry", (scenario) => {
    const result = cli(scenario, scenario === "no-wait" ? ["--no-wait"] : ["--if-match", '"reviewed"']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(scenario === "no-wait" ? "result: operation accepted" : "result: done");
    expect(result.stdout).toContain("requestId: req-test");
    expect(result.stdout).toContain("correlationId: corr-test");
    expect(result.stdout).toContain("durationSec:");
    expect(result.stdout).toContain("az-axi api GET");
    const calls = requests();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]).toEqual({ method: "PATCH", ifMatch: scenario === "no-wait" ? '"fresh"' : '"reviewed"' });
    expect(calls.slice(2).every((call) => call.method === "GET")).toBe(true);
    if (scenario === "no-wait") {
      expect(calls).toHaveLength(2);
      expect(result.stdout).toContain("az-axi op status");
      expect(result.stdout).toContain("review-to-execute protection was not used");
    }
    expect(entries()).toEqual([expect.objectContaining({ outcome: "success", method: "PATCH", requestId: "req-test" })]);
    expect(readFileSync(join(dir, "writes.log"), "utf8")).not.toMatch(/offline-execute-test-token|"body"|"headers"|"tags"/);
  });

  it.each(["precondition", "failure", "timeout", "network"])("reports %s with exit 1 and audits it", (scenario) => {
    const result = cli(scenario, ["--timeout", scenario === "timeout" ? "0.01" : "600", "--if-match", '"reviewed"']);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const code = scenario === "precondition" ? "PRECONDITION_FAILED" : scenario === "failure" ? "OPERATION_FAILED" :
      scenario === "timeout" ? "OPERATION_TIMEOUT" : "NETWORK_ERROR";
    expect(result.stdout).toContain(`code: ${code}`);
    expect(result.stdout).toContain("result: failed");
    expect(result.stdout).toContain("durationSec:");
    expect(result.stdout).toContain("az-axi api GET");
    if (scenario === "precondition") expect(result.stdout).toContain("re-run the dry run");
    if (scenario === "timeout") expect(result.stdout).toContain("az-axi op status");
    expect(entries()).toEqual([expect.objectContaining({ outcome: code })]);
  });

  it.each([["reader", ""], ["writer", "1"]])("blocks %s with read-only override %s before any fetch or audit", (profile, readOnly) => {
    for (const method of ["PUT", "PATCH", "POST", "DELETE"]) {
      const result = cli("sync", ["--confirm", "rg-demo"], profile, readOnly, method);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("WRITES_DISABLED");
      expect(result.stdout).not.toContain("allowWrites");
      expect(requests()).toEqual([]);
      expect(entries()).toEqual([]);
    }
  });

  it.each([["noop", "PATCH"], ["gone", "DELETE"]])("skips %s with only a GET and no audit entry", (scenario, method) => {
    const result = cli(scenario, ["--confirm", "rg-demo"], "writer", "", method);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("result: already in desired state (no-op)");
    expect(requests().map((request) => request.method)).toEqual(["GET"]);
    expect(entries()).toEqual([]);
  });

  it("returns a dry run without writing or auditing", () => {
    const result = cli("sync", ["--execute=false"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dryRun: true");
    expect(requests().map((request) => request.method)).toEqual(["GET"]);
    expect(entries()).toEqual([]);
  });
});
