import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";

const SUB = "00000000-0000-0000-0000-000000000021";
const OTHER = "00000000-0000-0000-0000-000000000022";
const RID = `/subscriptions/${SUB}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm1`;
const RG_ID = `/subscriptions/${SUB}/resourceGroups/rg-demo`;
const SUB_ID = `/subscriptions/${SUB}`;
const TAGS_URL = `https://management.azure.com${RID}/providers/Microsoft.Resources/tags/default?api-version=2021-04-01`;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-tag-update-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
    reader: { auth: "token", subscriptions: [SUB] },
    writer: { auth: "token", allowWrites: true, subscriptions: [SUB] },
  } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(extra: string[] = [], options: {
  operation?: string | null;
  tags?: string[] | null;
  resourceId?: string;
  profile?: string;
  readOnly?: string;
  scenario?: string;
  subscription?: string | null;
  tagsEnv?: string;
  tagsMissing?: boolean;
} = {}) {
  const argv = ["tag", "update", "--profile", options.profile ?? "writer"];
  if (options.subscription !== null) argv.push("-s", options.subscription ?? SUB);
  argv.push("--resource-id", options.resourceId ?? RID);
  if (options.operation !== null) argv.push("--operation", options.operation ?? "merge");
  if (options.tags !== null) {
    for (const pair of options.tags ?? ["env=prod"]) argv.push("--tags", pair);
  }
  argv.push(...extra);
  return spawnSync(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "test/apiWritesPreload.mjs")).href,
    "dist/bin/az-axi.js", ...argv], {
    encoding: "utf8",
    env: { ...process.env,
      MSYS2_ARG_CONV_EXCL: "*",
      AZ_AXI_CONFIG: join(dir, "config.json"),
      AZ_AXI_ARM_TOKEN: "offline-tag-token",
      AZ_AXI_PROFILE: "",
      AZ_AXI_TENANT: "",
      AZ_AXI_SUBSCRIPTION: "",
      AZ_AXI_READ_ONLY: options.readOnly ?? "",
      AZ_AXI_WRITE_LOG: join(dir, "writes.log"),
      AZ_AXI_TEST_OUTCOME: options.scenario ?? "sync",
      AZ_AXI_TEST_TAGS: options.tagsEnv ?? '{"env":"dev"}',
      ...(options.tagsMissing ? { AZ_AXI_TEST_TAGS_MISSING: "1" } : {}),
      AZ_AXI_TEST_CAPTURE_URL: "1",
      AZ_AXI_TEST_CAPTURE_BODY: "1",
      AZ_AXI_TEST_REQUESTS: join(dir, "requests.jsonl") },
  });
}

function records(file: string): Array<Record<string, unknown>> {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

describe("built tag update, offline only", () => {
  it("previews a merge with the tag-map diff and an exact native execute hint", () => {
    const result = cli(["--timeout", "30", "--no-wait"], { tags: ["env=prod", "owner=team"] });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("dryRun: true");
    expect(result.stdout).toContain("operation: Merge");
    expect(result.stdout).toContain("tags.env,dev,prod");
    expect(result.stdout).toContain("tags.owner,null,team");
    expect(result.stdout).toContain(String.raw`az-axi tag update --profile writer --subscription ${SUB} --resource-id ${RID} --operation merge --tags env=prod --tags owner=team --if-match '\"tags1\"' --timeout 30 --no-wait --execute`);
    expect(result.stdout).toContain("no ETag guarantee");
    expect(records("requests.jsonl")).toEqual([{ method: "GET", url: TAGS_URL }]);
    expect(records("writes.log")).toEqual([]);
  });

  it("previews a delete with removals and sends names through", () => {
    const result = cli([], { operation: "delete", tags: ["env=x"], tagsEnv: '{"env":"dev","old":"gone"}' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("operation: Delete");
    expect(result.stdout).toContain("tags.env,dev,null");
    expect(result.stdout).not.toContain("tags.old");
    expect(result.stdout).toContain(String.raw`--operation delete --tags env=x --if-match '\"tags1\"' --execute`);
    expect(records("requests.jsonl")).toEqual([{ method: "GET", url: TAGS_URL }]);
    expect(records("writes.log")).toEqual([]);
  });

  it("executes exactly one merge PATCH and audits it", () => {
    const result = cli(["--execute"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("result: done");
    expect(result.stdout).toContain("status: 200");
    expect(result.stdout).toContain("no ETag guarantee");
    const calls = records("requests.jsonl");
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(calls.at(-1)).toEqual({ method: "PATCH", url: TAGS_URL,
      ifMatch: '"tags1"',
      body: { operation: "Merge", properties: { tags: { env: "prod" } } } });
    expect(records("writes.log")).toEqual([expect.objectContaining({ class: "write", method: "PATCH",
      url: TAGS_URL, outcome: "success", httpStatus: 200, requestId: "req-test" })]);
    expect(readFileSync(join(dir, "writes.log"), "utf8")).not.toMatch(/offline-tag-token|"body"|"headers"|"properties"/);
  });

  it("executes exactly one delete PATCH and audits it", () => {
    const result = cli(["--execute"], { operation: "delete", tags: ["env=x"], tagsEnv: '{"env":"dev","old":"gone"}' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("result: done");
    const calls = records("requests.jsonl");
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(calls.at(-1)).toEqual({ method: "PATCH", url: TAGS_URL,
      ifMatch: '"tags1"',
      body: { operation: "Delete", properties: { tags: { env: null } } } });
    expect(records("writes.log")).toHaveLength(1);
  });

  it("pins a reviewed ETag when --if-match is passed", () => {
    const result = cli(["--execute", "--if-match", '"reviewed"']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(records("requests.jsonl").at(-1)).toMatchObject({ method: "PATCH", ifMatch: '"reviewed"' });
    expect(records("writes.log")).toHaveLength(1);
  });

  it.each([
    { operation: "merge", tags: ["env=prod"], change: "tags.Env,dev,prod", value: "prod" },
    { operation: "delete", tags: ["env=x"], change: "tags.Env,dev,null", value: null },
  ])("matches existing tag names case-insensitively for $operation", ({ operation, tags, change, value }) => {
    const options = { operation, tags, tagsEnv: '{"Env":"dev","owner":"team"}' };
    const preview = cli([], options);
    expect(preview.status, preview.stdout + preview.stderr).toBe(0);
    expect(preview.stdout).toContain(change);
    expect(preview.stdout).not.toContain("tags.env,null");
    expect(preview.stdout).not.toContain("tags.owner");
    const result = cli(["--execute"], options);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("result: done");
    expect(records("requests.jsonl").at(-1)).toMatchObject({ method: "PATCH",
      body: { properties: { tags: { env: value } } } });
  });

  it.each([{ flags: [] }, { flags: ["--execute"] }])("skips a matching merge across casing with $flags", ({ flags }) => {
    const result = cli(flags, { tags: ["env=dev"], tagsEnv: '{"Env":"dev"}' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(flags.length ? "already in desired state (no-op)" : "noop: true");
    expect(records("requests.jsonl")).toHaveLength(1);
    expect(records("writes.log")).toEqual([]);
  });

  it.each(["toString", "constructor", "__proto__"])("keeps unselected own tag %s during deletion", (name) => {
    const result = cli([], { operation: "delete", tags: ["env=x"],
      tagsEnv: JSON.stringify({ env: "dev", [name]: "keep" }) });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("tags.env,dev,null");
    expect(result.stdout).not.toContain(`tags.${name}`);
  });

  it.each(["toString", "constructor", "__proto__"])("deletes a selected own tag %s", (name) => {
    const result = cli(["--execute"], { operation: "delete", tags: [`${name}=x`],
      tagsEnv: JSON.stringify({ [name]: "dev", env: "keep" }) });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("result: done");
    expect(records("requests.jsonl").at(-1)).toMatchObject({ method: "PATCH",
      body: { operation: "Delete", properties: { tags: { [name]: null } } } });
  });

  it.each([
    { operation: "merge", tagsEnv: '{}' },
    { operation: "merge", tagsEnv: '{"password":"hunter2"}' },
    { operation: "delete", tagsEnv: '{"password":"old"}' },
    { operation: "delete", tagsEnv: '{}' },
  ])("redacts protected tag values in $operation hints with $tagsEnv", ({ operation, tagsEnv }) => {
    const result = cli([], { operation, tagsEnv, tags: ["password=hunter2"] });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("***redacted***");
    expect(result.stdout).not.toContain("hunter2");
    expect(records("writes.log")).toEqual([]);
  });

  it("sends the original protected value when executing a merge", () => {
    const result = cli(["--execute"], { tags: ["password=hunter2"], tagsEnv: '{}' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain("hunter2");
    expect(records("requests.jsonl").at(-1)).toMatchObject({ method: "PATCH",
      body: { operation: "Merge", properties: { tags: { password: "hunter2" } } } });
    expect(readFileSync(join(dir, "writes.log"), "utf8")).not.toContain("hunter2");
  });

  it("deduplicates equal values across tag-name casing", () => {
    const result = cli(["--execute"], { tags: ["Env=prod", "env=prod"] });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(records("requests.jsonl").at(-1)).toMatchObject({ method: "PATCH",
      body: { operation: "Merge", properties: { tags: { Env: "prod" } } } });
  });

  it("targets a resource group exactly", () => {
    const result = cli(["--execute"], { resourceId: RG_ID });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(records("requests.jsonl").at(-1)).toMatchObject({ method: "PATCH",
      url: `https://management.azure.com${RG_ID}/providers/Microsoft.Resources/tags/default?api-version=2021-04-01` });
  });

  describe.each(["merge", "delete"])("subscription-only scope refusal for %s", (operation) => {
    it.each([
      { flags: [], resourceId: SUB_ID },
      { flags: ["--execute"], resourceId: SUB_ID },
      { flags: [], resourceId: `${SUB_ID.toUpperCase()}/` },
      { flags: ["--execute"], resourceId: `${SUB_ID.toUpperCase()}/` },
    ])("refuses $resourceId with $flags before transport or audit", ({ flags, resourceId }) => {
      const result = cli(flags, { operation, resourceId });
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("VALIDATION_ERROR");
      expect(result.stdout).toContain("subscription-only scopes are not supported");
      expect(records("requests.jsonl")).toEqual([]);
      expect(records("writes.log")).toEqual([]);
    });
  });

  it.each([
    { flags: [], output: "noop: true" },
    { flags: ["--execute"], output: "already in desired state (no-op)" },
  ])("skips a matching merge with $flags and no audit", ({ flags, output }) => {
    const result = cli(flags, { tags: ["env=dev"] });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(output);
    expect(records("requests.jsonl")).toHaveLength(1);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    { flags: [], output: "noop: true" },
    { flags: ["--execute"], output: "already in desired state (no-op)" },
  ])("skips a delete of absent tags with $flags and no audit", ({ flags, output }) => {
    const result = cli(flags, { operation: "delete", tags: ["absent=x"] });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(output);
    expect(records("requests.jsonl")).toHaveLength(1);
    expect(records("writes.log")).toEqual([]);
  });

  it("previews creation when the scope has no tags yet", () => {
    const result = cli([], { tagsMissing: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("creates: true");
    expect(result.stdout).toContain("tags.env,null,prod");
    expect(records("requests.jsonl")).toEqual([{ method: "GET", url: TAGS_URL }]);
    expect(records("writes.log")).toEqual([]);
  });

  it("executes creation when the scope has no tags yet", () => {
    const result = cli(["--execute"], { tagsMissing: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("result: done");
    expect(records("requests.jsonl").map((call) => call.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(records("writes.log")).toHaveLength(1);
  });

  describe.each([
    { flags: [] as string[] },
    { flags: ["--execute"] },
  ])("subscription validation with $flags", ({ flags }) => {
    it.each(["Example", "not-a-guid", null])("refuses subscription %s before transport or audit", (subscription) => {
      const result = cli(flags, { subscription });
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("VALIDATION_ERROR");
      expect(records("requests.jsonl")).toEqual([]);
      expect(records("writes.log")).toEqual([]);
    });
  });

  it.each([
    { options: { resourceId: "relative/path" }, output: "full ARM ID" },
    { options: { resourceId: `${RID}?api-version=2021-04-01` }, output: "bare ARM ID" },
    { options: { resourceId: `${RID}/providers/Microsoft.Resources/tags/default` }, output: "tags wrapper" },
    { options: { resourceId: `/subscriptions/${OTHER}/resourceGroups/rg-demo` }, output: "conflicts with --subscription" },
    { options: { resourceId: "/providers/Microsoft.Management/managementGroups/example" }, output: "must start with /subscriptions" },
  ])("refuses resource id %j before transport or audit", ({ options, output }) => {
    const result = cli(["--execute"], options);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("VALIDATION_ERROR");
    expect(result.stdout).toContain(output);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    { operation: null, output: "needs --operation" },
    { operation: "replace", output: "must be merge or delete" },
    { operation: "upsert", output: "must be merge or delete" },
  ])("refuses operation %j before transport or audit", ({ operation, output }) => {
    const result = cli(["--execute"], { operation });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("VALIDATION_ERROR");
    expect(result.stdout).toContain(output);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    { tags: null, output: "needs --tags" },
    { tags: ["env"], output: "must be k=v" },
    { tags: ["=prod"], output: "must be k=v" },
    { tags: ["env=prod", "env=dev"], output: "conflicting values" },
    { tags: ["Env=prod", "env=dev"], output: "conflicting values" },
  ])("refuses tags %j before transport or audit", ({ tags, output }) => {
    const result = cli([], { tags });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("VALIDATION_ERROR");
    expect(result.stdout).toContain(output);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it("accepts repeated identical tag arguments", () => {
    const repeated = cli([], { tags: ["env=prod", "env=prod"] });
    expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0);
    expect(decode(repeated.stdout)).toMatchObject({ changes: [{ path: "tags.env", from: "dev", to: "prod" }] });
  });

  it.each([
    { flags: ["--tags", "note=a,b=c", "owner=team "], tags: { note: "a,b=c", owner: "team " } },
    { flags: ["--tags", "note=a,b=c", "--tags", "owner=team "], tags: { note: "a,b=c", owner: "team " } },
    { flags: ["--tags=note=a,b=c", "--tags=owner=team "], tags: { note: "a,b=c", owner: "team " } },
    { flags: ["--tags", "note= a=b,c ", "owner="], tags: { note: " a=b,c ", owner: "" } },
  ])("preserves individual tag values through preview and execution with $flags", ({ flags, tags }) => {
    const preview = cli(flags, { tags: null, tagsEnv: '{}' });
    expect(preview.status, preview.stdout + preview.stderr).toBe(0);
    expect(decode(preview.stdout)).toMatchObject({ changes: [
      { path: "tags.note", from: null, to: tags.note },
      { path: "tags.owner", from: null, to: tags.owner },
    ] });
    const result = cli([...flags, "--execute"], { tags: null, tagsEnv: '{}' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(records("requests.jsonl").at(-1)).toMatchObject({ method: "PATCH",
      body: { operation: "Merge", properties: { tags } } });
  });

  it.each([
    ["reader", "", [], "WRITES_DISABLED"],
    ["writer", "1", [], "WRITES_DISABLED"],
    ["writer", "", ["--body", "{}"], "UNKNOWN_FLAG"],
    ["writer", "", ["--management-group", "example-mg"], "VALIDATION_ERROR"],
  ])("refuses %s %s %j before transport or audit", (profile, readOnly, extra, code) => {
    const result = cli(["--execute", ...extra], { profile, readOnly });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`code: ${code}`);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it("refuses a subscription outside the profile allowlist", () => {
    const otherRid = `/subscriptions/${OTHER}/resourceGroups/rg-demo`;
    const result = cli(["--execute"], { subscription: OTHER, resourceId: otherRid });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code: SUBSCRIPTION_NOT_WRITABLE");
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it("reports a missing target from the PATCH and audits the failure", () => {
    // A missing tags wrapper previews as creation (as for api PUT-creates);
    // only the PATCH reveals the truly missing target, and it is audited.
    const result = cli(["--execute"], { scenario: "gone" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("NOT_FOUND");
    expect(records("requests.jsonl").map((call) => call.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(records("writes.log")).toEqual([expect.objectContaining({ class: "write", method: "PATCH",
      url: TAGS_URL, outcome: "NOT_FOUND", httpStatus: 404 })]);
  });

  it("reports a conflict through the shared execution and audit handling", () => {
    const result = cli(["--execute", "--if-match", '"reviewed"'], { scenario: "precondition" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PRECONDITION_FAILED");
    expect(records("writes.log")).toHaveLength(1);
    expect(records("requests.jsonl").filter((call) => call.method === "PATCH")).toHaveLength(1);
  });
});
