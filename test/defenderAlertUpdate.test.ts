import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SUB = "00000000-0000-0000-0000-000000000021";
const OTHER = "00000000-0000-0000-0000-000000000022";
const ALERT = `/subscriptions/${SUB}/providers/Microsoft.Security/locations/westeurope/alerts/example-alert`;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-alert-update-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
    reader: { auth: "token", subscriptions: [SUB] },
    writer: { auth: "token", allowWrites: true, subscriptions: [SUB] },
  } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(extra: string[] = [], options: { route?: string; scenario?: string; status?: string; profile?: string; readOnly?: string; action?: string; name?: string } = {}) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "test/apiWritesPreload.mjs")).href,
    "dist/bin/az-axi.js", ...(options.route ?? "security alert update").split(" "),
    "-l", "westeurope", "-n", options.name ?? "example-alert", "--status", options.action ?? "dismiss",
    "--profile", options.profile ?? "writer", ...extra], {
    encoding: "utf8", env: { ...process.env, AZ_AXI_CONFIG: join(dir, "config.json"),
      AZ_AXI_ARM_TOKEN: "offline-alert-token", AZ_AXI_PROFILE: "", AZ_AXI_TENANT: "", AZ_AXI_SUBSCRIPTION: "",
      AZ_AXI_READ_ONLY: options.readOnly ?? "", AZ_AXI_WRITE_LOG: join(dir, "writes.log"),
      AZ_AXI_TEST_OUTCOME: options.scenario ?? "sync", AZ_AXI_TEST_ALERT_STATUS: options.status ?? "Active",
      AZ_AXI_TEST_CAPTURE_URL: "1", AZ_AXI_TEST_CAPTURE_BODY: "1", AZ_AXI_TEST_REQUESTS: join(dir, "requests.jsonl") },
  });
}

function records(file: string): Array<Record<string, unknown>> {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

describe("built Defender alert update, offline only", () => {
  it.each(["security alert update", "defender alerts update"])("previews %s with an exact native execute hint", (route) => {
    const result = cli(["-s", SUB, "--timeout", "30", "--no-wait"], { route });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("dryRun: true");
    expect(result.stdout).toContain("properties.status,Active,Dismissed");
    expect(result.stdout).toContain(`az-axi security alert update --profile writer --subscription ${SUB}`);
    expect(result.stdout).toContain("--timeout 30 --no-wait --execute");
    expect(result.stdout).toContain("no concurrency guarantee");
    expect(records("requests.jsonl")).toEqual([{ method: "GET", url: `https://management.azure.com${ALERT}?api-version=2022-01-01` }]);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    ["dismiss", "Dismissed"], ["resolve", "Resolved"], ["activate", "Active"],
  ])("executes exactly one bodyless %s action and audits it", (action) => {
    const route = cli(["--execute", "--if-match", '"reviewed"'], { action, status: "InProgress" });
    expect(route.status, route.stdout + route.stderr).toBe(0);
    expect(route.stdout).toContain("result: done");
    expect(route.stdout).toContain("status: 204");
    expect(route.stdout).toContain("no concurrency guarantee");
    expect(records("requests.jsonl")).toEqual([
      { method: "GET", url: `https://management.azure.com${ALERT}?api-version=2022-01-01` },
      { method: "POST", url: `https://management.azure.com${ALERT}/${action}?api-version=2022-01-01`, ifMatch: '"reviewed"' },
    ]);
    expect(records("writes.log")).toEqual([expect.objectContaining({ class: "write", method: "POST",
      url: `https://management.azure.com${ALERT}/${action}?api-version=2022-01-01`,
      outcome: "success", httpStatus: 204, requestId: "req-test" })]);
    expect(readFileSync(join(dir, "writes.log"), "utf8")).not.toMatch(/offline-alert-token|"body"|"headers"|"properties"/);
  });

  it("targets the selected resource group and resolves an allowed subscription name", () => {
    const result = cli(["-s", "Example", "-g", "example-rg", "--execute"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(records("requests.jsonl").at(-1)?.url).toBe(`https://management.azure.com/subscriptions/${SUB}/resourceGroups/example-rg/providers/Microsoft.Security/locations/westeurope/alerts/example-alert/dismiss?api-version=2022-01-01`);
  });

  it("refuses a resolved subscription name outside the configured write allowlist", () => {
    const result = cli(["-s", "Other", "--execute"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("SUBSCRIPTION_NOT_WRITABLE");
    expect(records("requests.jsonl")).toEqual([{ method: "GET", url: "https://management.azure.com/subscriptions?api-version=2022-12-01" }]);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    { flags: [], action: "dismiss", status: "Dismissed", output: "noop: true" },
    { flags: ["--execute"], action: "dismiss", status: "Dismissed", output: "already in desired state (no-op)" },
    { flags: ["--execute"], action: "resolve", status: "Resolved", output: "already in desired state (no-op)" },
    { flags: ["--execute"], action: "activate", status: "Active", output: "already in desired state (no-op)" },
  ])("skips an already $status alert with $flags and no audit", ({ flags, action, status, output }) => {
    const result = cli(flags, { action, status });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(output);
    expect(records("requests.jsonl")).toHaveLength(1);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    ["reader", "", [], "WRITES_DISABLED"], ["writer", "1", [], "WRITES_DISABLED"],
    ["writer", "", ["-s", OTHER], "SUBSCRIPTION_NOT_WRITABLE"],
    ["writer", "", ["-s", `${SUB},${OTHER}`], "VALIDATION_ERROR"],
    ["writer", "", ["--body", "{}"], "UNKNOWN_FLAG"],
    ["writer", "", ["--confirm", "example-alert"], "UNKNOWN_FLAG"],
    ["writer", "", ["--management-group", "example-mg"], "VALIDATION_ERROR"],
  ])("refuses %s %s %j before transport or audit", (profile, readOnly, extra, code) => {
    const result = cli(["--execute", ...extra], { profile, readOnly });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`code: ${code}`);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it("refuses a missing alert instead of invoking its action", () => {
    const result = cli(["--execute"], { scenario: "gone" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("NOT_FOUND");
    expect(records("requests.jsonl")).toHaveLength(1);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    { action: "listKeys" }, { action: "inprogress" }, { name: "../listKeys" }, { name: "%2f.." },
  ])("refuses an unsupported action or unsafe name %j", (options) => {
    const result = cli(["--execute"], options);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("VALIDATION_ERROR");
    expect(records("requests.jsonl")).toEqual([]);
  });

  it.each(["async", "no-wait", "precondition", "failure"])("uses shared %s execution and audit handling", (scenario) => {
    const result = cli(["--execute", "--if-match", '"reviewed"', ...(scenario === "no-wait" ? ["--no-wait"] : [])], { scenario });
    expect(result.status).toBe(["precondition", "failure"].includes(scenario) ? 1 : 0);
    expect(result.stdout).toContain(scenario === "precondition" ? "PRECONDITION_FAILED" : scenario === "failure" ? "OPERATION_FAILED" : scenario === "no-wait" ? "operation accepted" : "result: done");
    expect(records("writes.log")).toHaveLength(1);
    expect(records("requests.jsonl").filter((call) => call.method === "POST")).toHaveLength(1);
    if (scenario === "no-wait") expect(records("requests.jsonl")).toHaveLength(2);
  });
});
