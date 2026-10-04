import { spawnSync } from "node:child_process";
import { decode } from "@toon-format/toon";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SUB = "00000000-0000-0000-0000-000000000021";
const OTHER = "00000000-0000-0000-0000-000000000022";
const INCIDENT = "00000000-0000-0000-0000-000000000063";
const INCIDENT_ID = `/subscriptions/${SUB}/resourceGroups/rg-demo/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/${INCIDENT}`;
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000010";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-sentinel-update-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
    reader: { auth: "token", subscriptions: [SUB] },
    writer: { auth: "token", allowWrites: true, subscriptions: [SUB] },
    alias: { auth: "token", allowWrites: true, subscriptions: [SUB], workspaces: { sentinel: WORKSPACE_ID } },
    writer2: { auth: "token", allowWrites: true, subscriptions: [SUB, OTHER] },
  } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface CliOptions {
  route?: "update" | "comment";
  scenario?: string;
  profile?: string;
  readOnly?: string;
  subscription?: string | null;
  incident?: string | null;
  ids?: boolean;
  workspaceAlias?: boolean;
  status?: string | null;
  severity?: string | null;
  owner?: string | null;
  classification?: string | null;
  reason?: string | null;
  comment?: string | null;
  message?: string | null;
  incidentStatus?: string;
  incidentSeverity?: string;
  incidentClassification?: string;
}

function cli(extra: string[] = [], options: CliOptions = {}) {
  const route = options.route ?? "update";
  const profile = options.profile ?? "writer";
  const argv: string[] = route === "update"
    ? ["sentinel", "incident", "update"]
    : ["sentinel", "incident", "comment", "create"];
  if (options.ids) {
    argv.push("--ids", INCIDENT_ID);
    if (options.incident !== undefined) argv.push("--name", options.incident);
  } else if (route === "update") {
    argv.push("--name", options.incident ?? INCIDENT);
    if (options.workspaceAlias) argv.push("--workspace", "sentinel");
    else argv.push("-g", "rg-demo", "--workspace-name", "logs-demo");
  } else {
    argv.push("--incident-id", options.incident ?? INCIDENT);
    if (options.workspaceAlias) argv.push("--workspace", "sentinel");
    else argv.push("-g", "rg-demo", "--workspace-name", "logs-demo");
  }
  if (route === "update") {
    if (options.status !== null) argv.push("--status", options.status ?? "closed");
    if (options.severity !== undefined && options.severity !== null) argv.push("--severity", options.severity);
    if (options.owner !== undefined && options.owner !== null) argv.push("--owner", options.owner);
    if (options.classification !== null) argv.push("--classification", options.classification ?? "FalsePositive");
    if (options.reason !== null) argv.push("--classification-reason", options.reason ?? "IncorrectAlertLogic");
    if (options.comment !== undefined && options.comment !== null) argv.push("--classification-comment", options.comment);
  } else {
    if (options.message !== null) argv.push("--message", options.message ?? "Offline triage note");
  }
  argv.push("--profile", profile);
  if (options.subscription !== null) argv.push("-s", options.subscription ?? SUB);
  argv.push(...extra);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    MSYS2_ARG_CONV_EXCL: "*",
    AZ_AXI_CONFIG: join(dir, "config.json"),
    AZ_AXI_PROFILE: "",
    AZ_AXI_TENANT: "",
    AZ_AXI_SUBSCRIPTION: "",
    AZ_AXI_READ_ONLY: options.readOnly ?? "",
    AZ_AXI_WRITE_LOG: join(dir, "writes.log"),
    AZ_AXI_ARM_TOKEN: "offline-sentinel-token",
    AZ_AXI_TEST_OUTCOME: options.scenario ?? "sync",
    AZ_AXI_TEST_CAPTURE_URL: "1",
    AZ_AXI_TEST_CAPTURE_BODY: "1",
    AZ_AXI_TEST_REQUESTS: join(dir, "requests.jsonl"),
    AZ_AXI_TEST_WORKSPACE_ID: WORKSPACE_ID,
  };
  if (options.incidentStatus !== undefined) env.AZ_AXI_TEST_INCIDENT_STATUS = options.incidentStatus;
  if (options.incidentSeverity !== undefined) env.AZ_AXI_TEST_INCIDENT_SEVERITY = options.incidentSeverity;
  if (options.incidentClassification !== undefined) env.AZ_AXI_TEST_INCIDENT_CLASSIFICATION = options.incidentClassification;
  return spawnSync(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "test/apiWritesPreload.mjs")).href,
    "dist/bin/az-axi.js", ...argv], { encoding: "utf8", env });
}

function records(file: string): Array<Record<string, unknown>> {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function putCall() {
  return records("requests.jsonl").filter((call) => call.method === "PUT").at(-1);
}

describe("built Sentinel incident update, offline only", () => {
  it("previews an update with the diff and an exact native execute hint", () => {
    const result = cli(["--timeout", "30", "--no-wait"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("dryRun: true");
    expect(result.stdout).toContain("properties.status,Active,Closed");
    expect(result.stdout).toContain("properties.classification,Undetermined,FalsePositive");
    expect(result.stdout).toContain("properties.classificationReason");
    expect(result.stdout).toContain("IncorrectAlertLogic");
    expect(result.stdout).toContain("compare-and-swap");
    expect(result.stdout).toContain(`az-axi sentinel incident update --profile writer --subscription ${SUB}`);
    expect(result.stdout).toContain(`--name ${INCIDENT} --resource-group rg-demo --workspace-name logs-demo`);
    expect(result.stdout).toContain("--status Closed --classification FalsePositive");
    expect(result.stdout).toContain("--timeout 30 --no-wait --execute");
    const calls = records("requests.jsonl");
    expect((decode(result.stdout) as { help: string[] }).help[0]).toContain("--if-match '\"fresh\"'");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "GET", url: `https://management.azure.com${INCIDENT_ID}?api-version=2025-09-01` });
    expect(records("writes.log")).toEqual([]);
  });

  it("executes one merged PUT and audits it", () => {
    const result = cli(["--execute", "--if-match", '"reviewed"']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("result: done");
    expect(result.stdout).toContain("status: 200");
    expect(result.stdout).toContain("compare-and-swap");
    const calls = records("requests.jsonl");
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
    expect(putCall()).toMatchObject({
      method: "PUT",
      url: `https://management.azure.com${INCIDENT_ID}?api-version=2025-09-01`,
      ifMatch: '"reviewed"',
    });
    const body = (putCall()?.body ?? {}) as { properties?: Record<string, unknown> };
    expect(body.properties).toMatchObject({ status: "Closed", classification: "FalsePositive" });
    expect(body.properties?.title).toBe("Offline incident");
    expect(records("writes.log")).toEqual([expect.objectContaining({ class: "write", method: "PUT",
      url: `https://management.azure.com${INCIDENT_ID}?api-version=2025-09-01`,
      outcome: "success", httpStatus: 200, requestId: "req-test" })]);
    expect(readFileSync(join(dir, "writes.log"), "utf8")).not.toMatch(/offline-sentinel-token|"headers"|"email"/);
  });

  it("sends the fresh ETag when --if-match is absent", () => {
    const result = cli(["--execute"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(putCall()).toMatchObject({ ifMatch: '"fresh"' });
  });

  it("previews the merged incident and ETag from one snapshot", () => {
    const result = cli([], { scenario: "incident-race", status: null, severity: "low", classification: null, reason: null });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("properties.severity,High,Low");
    expect(result.stdout).not.toContain("properties.status,");
    expect((decode(result.stdout) as { help: string[] }).help[0]).toContain("--if-match '\"E1\"'");
    expect(records("requests.jsonl")).toHaveLength(1);
  });

  it("rejects a change between the merge snapshot and PUT", () => {
    const result = cli(["--execute"], { scenario: "incident-race", status: null, severity: "low", classification: null, reason: null });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PRECONDITION_FAILED");
    expect(putCall()).toMatchObject({ ifMatch: '\"E1\"', body: { properties: { status: "Active", severity: "Low" } } });
    expect(records("requests.jsonl").filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it.each([{ flags: [] }, { flags: ["--if-match", '\"older\"'] }])("pins the preview ETag in the execute hint with $flags", ({ flags }) => {
    const preview = cli(flags, { status: null, severity: "low", classification: null, reason: null });
    expect(preview.status, preview.stdout + preview.stderr).toBe(0);
    const output = decode(preview.stdout) as { help: string[]; etag: string };
    expect(output.help[0]).toContain("--if-match '\"fresh\"'");
    expect(output.help[0]).not.toContain("--if-match '\"older\"'");
    const result = cli(["--execute", "--if-match", output.etag], {
      scenario: "review-stale", status: null, severity: "low", classification: null, reason: null,
      incidentSeverity: "Medium",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PRECONDITION_FAILED");
    expect(putCall()).toMatchObject({ ifMatch: '\"fresh\"' });
  });

  it.each([
    ["number", { incident: "3177" }],
    ["ARM ID", { ids: true }],
    ["workspace alias", { workspaceAlias: true, profile: "alias" }],
  ])("selects the incident by %s", (_label, options) => {
    const result = cli(["--execute"], options);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("result: done");
    expect(putCall()?.url).toBe(`https://management.azure.com${INCIDENT_ID}?api-version=2025-09-01`);
  });

  it.each([
    ["00000000-0000-0000-0000-000000000080", { objectId: "00000000-0000-0000-0000-000000000080" }],
    ["hunter@contoso.com", { email: "hunter@contoso.com", userPrincipalName: "hunter@contoso.com" }],
    ["Casey Hunter", { assignedTo: "Casey Hunter" }],
  ])("maps --owner %s to its owner shape", (owner, shape) => {
    const result = cli(["--execute"], { status: "active", owner, classification: null, reason: null });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect((putCall()?.body as { properties?: unknown })?.properties).toMatchObject({ owner: shape });
  });

  it.each([
    { flags: [], output: "noop: true" },
    { flags: ["--execute"], output: "already in desired state (no-op)" },
  ])("skips a matching incident with $flags and no audit", ({ flags, output }) => {
    const result = cli(flags, { status: "active", classification: null, reason: null });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(output);
    expect(records("requests.jsonl").filter((call) => call.method === "PUT")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    ["reader", "", [], "WRITES_DISABLED", {}],
    ["writer", "1", [], "WRITES_DISABLED", {}],
    ["writer", "", ["-s", OTHER], "SUBSCRIPTION_NOT_WRITABLE", {}],
    ["writer", "", ["-s", `${SUB},${OTHER}`], "VALIDATION_ERROR", {}],
    ["writer", "", [], "VALIDATION_ERROR", { subscription: null }],
    ["writer", "", ["--body", "{}"], "UNKNOWN_FLAG", {}],
    ["writer", "", ["--confirm", INCIDENT], "UNKNOWN_FLAG", {}],
    ["writer", "", ["--management-group", "example-mg"], "VALIDATION_ERROR", {}],
  ])("refuses %s %s %j before transport or audit", (profile, readOnly, extra, code, options = {}) => {
    const result = cli(["--execute", ...extra], { profile, readOnly, subscription: extra.includes("-s") ? null : SUB, ...options });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`code: ${code}`);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    [{ status: "bogus" }, "--status must be New, Active or Closed"],
    [{ severity: "critical" }, "--severity must be High, Medium, Low or Informational"],
    [{ classification: "maybe" }, "--classification must be Undetermined"],
    [{ reason: "guessing" }, "--classification-reason must be SuspiciousActivity"],
    [{ classification: null, reason: null }, "closing an incident (--status Closed) requires --classification"],
    [{ classification: null, reason: "IncorrectAlertLogic", status: "active", severity: "high" },
      "--classification-reason and --classification-comment require --classification"],
    [{ status: null, classification: null, reason: null }, "incident update needs at least one of"],
    [{ incident: "not-a-guid" }, "--name must be the incident GUID"],
    [{ incident: "not-a-guid", ids: true }, "incident update takes --name or --ids, not both"],
    [{ ids: true, subscription: OTHER, profile: "writer2" }, "--ids conflicts with --subscription"],
  ])("refuses invalid update %j before transport or audit", (options, message) => {
    const result = cli(["--execute"], { ...(options as CliOptions) });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("VALIDATION_ERROR");
    expect(result.stdout).toContain(message);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it("refuses a missing incident instead of sending the PUT", () => {
    const result = cli(["--execute"], { scenario: "gone" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("NOT_FOUND");
    expect(records("requests.jsonl")).toHaveLength(1);
    expect(records("writes.log")).toEqual([]);
  });

  it.each(["async", "no-wait", "precondition", "failure"])("uses shared %s execution and audit handling", (scenario) => {
    const result = cli(["--execute", "--if-match", '"reviewed"', ...(scenario === "no-wait" ? ["--no-wait"] : [])], { scenario });
    expect(result.status).toBe(["precondition", "failure"].includes(scenario) ? 1 : 0);
    expect(result.stdout).toContain(scenario === "precondition" ? "PRECONDITION_FAILED" : scenario === "failure" ? "OPERATION_FAILED" : scenario === "no-wait" ? "operation accepted" : "result: done");
    expect(records("writes.log")).toHaveLength(1);
    expect(records("requests.jsonl").filter((call) => call.method === "PUT")).toHaveLength(1);
  });
});

describe.each([
  { route: "update" as const, flags: [] },
  { route: "update" as const, flags: ["--execute"] },
  { route: "comment" as const, flags: [] },
  { route: "comment" as const, flags: ["--execute"] },
])("Sentinel $route selector validation with $flags", ({ route, flags }) => {
  it.each(["workspace", "workspace-name", "resource-group"])("rejects --ids with --%s before transport", (selector) => {
    const result = cli([...flags, `--${selector}`, "copied-workspace"], { route, ids: true });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code: VALIDATION_ERROR");
    expect(result.stdout).toContain("workspace selectors are not accepted with --ids");
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });
});

describe.each([{ flags: [] }, { flags: ["--execute"] }])("Sentinel enum validation with $flags", ({ flags }) => {
  it.each([
    [{ status: "__proto__" }, "--status must be New, Active or Closed"],
    [{ status: "constructor" }, "--status must be New, Active or Closed"],
    [{ severity: "__proto__" }, "--severity must be High, Medium, Low or Informational"],
    [{ severity: "constructor" }, "--severity must be High, Medium, Low or Informational"],
    [{ classification: "__proto__" }, "--classification must be Undetermined"],
    [{ classification: "constructor" }, "--classification must be Undetermined"],
    [{ reason: "__proto__" }, "--classification-reason must be SuspiciousActivity"],
    [{ reason: "constructor" }, "--classification-reason must be SuspiciousActivity"],
  ])("rejects inherited enum key %j before transport", (options, message) => {
    const result = cli(flags, options);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code: VALIDATION_ERROR");
    expect(result.stdout).toContain(message);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });
});

describe("built Sentinel incident comment create, offline only", () => {
  it("previews a new comment with creates:true and an exact execute hint", () => {
    const result = cli([], { route: "comment" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("dryRun: true");
    expect(result.stdout).toContain("creates: true");
    expect(result.stdout).toContain("az-axi sentinel incident comment create --profile writer");
    expect(result.stdout).toContain("--incident-id");
    expect(result.stdout).toContain("--message 'Offline triage note' --execute");
    expect(records("requests.jsonl")).toEqual([
      { method: "GET", url: expect.stringContaining("/comments/") },
    ]);
    expect(records("writes.log")).toEqual([]);
  });

  it("executes one comment PUT and audits it", () => {
    const result = cli(["--execute"], { route: "comment" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("result: done");
    expect(result.stdout).toContain("status: 201");
    expect(putCall()).toMatchObject({ method: "PUT" });
    expect(String(putCall()?.url)).toMatch(new RegExp(`^https://management.azure.com${INCIDENT_ID}/comments/[0-9a-f-]{36}\\?api-version=2025-09-01$`));
    expect(putCall()?.body).toEqual({ properties: { message: "Offline triage note" } });
    expect(records("writes.log")).toEqual([expect.objectContaining({ class: "write", method: "PUT",
      url: putCall()?.url, outcome: "success", httpStatus: 201, requestId: "req-test" })]);
    expect(readFileSync(join(dir, "writes.log"), "utf8")).not.toMatch(/offline-sentinel-token|"headers"|Offline triage note/);
  });

  it.each([
    ["number", { incident: "3177" }],
    ["ARM ID", { ids: true }],
    ["workspace alias", { workspaceAlias: true, profile: "alias" }],
  ])("adds a comment to an incident selected by %s", (_label, options) => {
    const result = cli(["--execute"], { route: "comment", ...options });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(putCall()?.url).toEqual(expect.stringContaining(`https://management.azure.com${INCIDENT_ID}/comments/`));
    expect(records("requests.jsonl").filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("adds a separate comment when invoked again with the same message", () => {
    const first = cli(["--execute"], { route: "comment" });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const firstUrl = putCall()?.url;
    const second = cli(["--execute"], { route: "comment" });
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(putCall()?.url).not.toBe(firstUrl);
    expect(records("requests.jsonl").filter((call) => call.method === "PUT")).toHaveLength(2);
    expect(records("writes.log")).toHaveLength(2);
  });

  it.each([
    { flags: ["--name", "00000000-0000-0000-0000-000000000064"] },
    { flags: ["-n", "00000000-0000-0000-0000-000000000064"] },
    { flags: ["--if-match", '\"fresh\"'] },
    { flags: ["--execute", "--name", "00000000-0000-0000-0000-000000000064"] },
    { flags: ["--execute", "-n", "00000000-0000-0000-0000-000000000064"] },
    { flags: ["--execute", "--if-match", '\"fresh\"'] },
  ])("rejects comment overwrite flags $flags before transport", ({ flags }) => {
    const result = cli(flags, { route: "comment" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code: UNKNOWN_FLAG");
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    ["reader", "", [], "WRITES_DISABLED", {}],
    ["writer", "1", [], "WRITES_DISABLED", {}],
    ["writer", "", ["-s", OTHER], "SUBSCRIPTION_NOT_WRITABLE", {}],
    ["writer", "", [], "VALIDATION_ERROR", { subscription: null }],
    ["writer", "", [], "VALIDATION_ERROR", { message: null }],
    ["writer", "", ["--body", "{}"], "UNKNOWN_FLAG", {}],
    ["writer", "", [], "VALIDATION_ERROR", { incident: "not-a-guid" }],
  ])("refuses comment %s %s %j before transport or audit", (profile, readOnly, extra, code, options = {}) => {
    const result = cli(["--execute", ...extra], { route: "comment", profile, readOnly,
      subscription: extra.includes("-s") ? null : SUB, ...(options as CliOptions) });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`code: ${code}`);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it("reports a missing incident instead of creating the comment", () => {
    const result = cli(["--execute"], { route: "comment", scenario: "gone" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("NOT_FOUND");
    expect(records("requests.jsonl").filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(records("writes.log")).toHaveLength(1);
  });

  it.each(["async", "no-wait", "precondition", "failure"])("uses shared %s execution and audit handling", (scenario) => {
    const result = cli(["--execute", ...(scenario === "no-wait" ? ["--no-wait"] : [])], { route: "comment", scenario });
    expect(result.status).toBe(["precondition", "failure"].includes(scenario) ? 1 : 0);
    expect(result.stdout).toContain(scenario === "precondition" ? "PRECONDITION_FAILED" : scenario === "failure" ? "OPERATION_FAILED" : scenario === "no-wait" ? "operation accepted" : "result: done");
    expect(records("writes.log")).toHaveLength(1);
    expect(records("requests.jsonl").filter((call) => call.method === "PUT")).toHaveLength(1);
  });
});
