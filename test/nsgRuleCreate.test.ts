import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";

const SUB = "00000000-0000-0000-0000-000000000021";
const OTHER = "00000000-0000-0000-0000-000000000022";
const NSG_ID = `/subscriptions/${SUB}/resourceGroups/rg-demo/providers/Microsoft.Network/networkSecurityGroups/nsg-web`;
const RULE = "deny-telnet";
const RULE_URL = `https://management.azure.com${NSG_ID}/securityRules/${RULE}?api-version=2024-05-01`;
const NSG_URL = `https://management.azure.com${NSG_ID}?api-version=2024-05-01`;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-nsg-rule-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
    reader: { auth: "token", subscriptions: [SUB] },
    writer: { auth: "token", allowWrites: true, subscriptions: [SUB] },
  } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(extra: string[] = [], options: {
  profile?: string;
  readOnly?: string;
  scenario?: string;
  subscription?: string | null;
  ids?: boolean;
  nsgName?: string | null;
  group?: string | null;
  name?: string | null;
  priority?: string | null;
  nsgRules?: string;
  nsgMissing?: boolean;
  ruleExists?: boolean;
} = {}) {
  const argv = ["network", "nsg", "rule", "create", "--profile", options.profile ?? "writer"];
  if (options.subscription !== null) argv.push("-s", options.subscription ?? SUB);
  if (options.ids) {
    argv.push("--ids", NSG_ID);
  } else {
    if (options.nsgName !== null) argv.push("--nsg-name", options.nsgName ?? "nsg-web");
    if (options.group !== null) argv.push("-g", options.group ?? "rg-demo");
  }
  if (options.name !== null) argv.push("--name", options.name ?? RULE);
  if (options.priority !== null) argv.push("--priority", options.priority ?? "400");
  argv.push(...extra);
  return spawnSync(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "test/apiWritesPreload.mjs")).href,
    "dist/bin/az-axi.js", ...argv], {
    encoding: "utf8",
    env: { ...process.env,
      MSYS2_ARG_CONV_EXCL: "*",
      AZ_AXI_CONFIG: join(dir, "config.json"),
      AZ_AXI_ARM_TOKEN: "offline-nsg-token",
      AZ_AXI_PROFILE: "",
      AZ_AXI_TENANT: "",
      AZ_AXI_SUBSCRIPTION: "",
      AZ_AXI_READ_ONLY: options.readOnly ?? "",
      AZ_AXI_WRITE_LOG: join(dir, "writes.log"),
      AZ_AXI_TEST_OUTCOME: options.scenario ?? "sync",
      ...(options.nsgRules === undefined ? {} : { AZ_AXI_TEST_NSG_RULES: options.nsgRules }),
      ...(options.nsgMissing ? { AZ_AXI_TEST_NSG_MISSING: "1" } : {}),
      ...(options.ruleExists ? { AZ_AXI_TEST_NSG_RULE_EXISTS: "1" } : {}),
      AZ_AXI_TEST_CAPTURE_URL: "1",
      AZ_AXI_TEST_CAPTURE_BODY: "1",
      AZ_AXI_TEST_REQUESTS: join(dir, "requests.jsonl") },
  });
}

function records(file: string): Array<Record<string, unknown>> {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

describe("built NSG deny-rule create, offline only", () => {
  it("previews one deny rule with the existing rules and an exact destructive execute hint", () => {
    const result = cli(["--protocol", "Tcp", "--destination-port-ranges", "23", "--description", "block telnet"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("dryRun: true");
    expect(result.stdout).toContain("class: destructive");
    expect(result.stdout).toContain("method: PUT");
    expect(result.stdout).toContain("securityRules/deny-telnet");
    expect(result.stdout).toContain("allow-https");
    expect(result.stdout).toContain("deny-ssh");
    expect(result.stdout).toContain("totalRules: 2");
    expect(result.stdout).toContain("access: Deny");
    expect(result.stdout).toContain("no concurrency guarantee");
    expect(result.stdout).toContain(
      String.raw`az-axi network nsg rule create --profile writer --nsg-name nsg-web --resource-group rg-demo --name deny-telnet --priority 400 --direction Inbound --access Deny --protocol Tcp --source-address-prefixes '*' --source-port-ranges '*' --destination-address-prefixes '*' --destination-port-ranges 23 --description 'block telnet' --subscription ${SUB} --if-match '\"nsg1\"' --execute --confirm deny-telnet`,
    );
    expect(records("requests.jsonl")).toEqual([{ method: "GET", url: NSG_URL }]);
    expect(records("writes.log")).toEqual([]);
  });

  it("previews through --ids with the subscription from the flag", () => {
    const result = cli([], { ids: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("dryRun: true");
    expect(result.stdout).toContain("securityRules/deny-telnet");
    expect(result.stdout).toContain("--ids");
    expect(records("requests.jsonl")).toEqual([{ method: "GET", url: NSG_URL }]);
    expect(records("writes.log")).toEqual([]);
  });

  describe.each([
    { ids: false, selector: "--name nsg-web --resource-group rg-demo" },
    { ids: true, selector: `--ids ${NSG_ID}` },
  ])("NSG inspection hints with ids=$ids", ({ ids, selector }) => {
    it.each([
      { extra: ["--limit", "1"], name: RULE, priority: "400", status: 0, reason: "every existing rule" },
      { extra: [], name: "allow-HTTPS", priority: "400", status: 2, reason: "the current rules" },
      { extra: ["--direction", "Outbound"], name: RULE, priority: "200", status: 2, reason: "the current rules" },
    ])("preserves scope and shows all rules for $name at priority $priority", ({ extra, name, priority, status, reason }) => {
      const config = join(dir, "config.json");
      const result = cli([...extra, "--tenant", OTHER, "--config", config], { ids, name, priority });
      expect(result.status, result.stdout + result.stderr).toBe(status);
      const output = decode(result.stdout) as { help: string[] };
      expect(output.help).toContain(
        `Run \`az-axi network nsg show --profile writer --tenant ${OTHER} --config ${config} ${selector} --subscription ${SUB} --full\` for ${reason}`,
      );
      expect(records("requests.jsonl")).toEqual([{ method: "GET", url: NSG_URL }]);
      expect(records("writes.log")).toEqual([]);
    });
  });

  it("executes exactly one destructive PUT and audits it", () => {
    const result = cli(["--protocol", "Tcp", "--destination-port-ranges", "23", "--direction", "Outbound",
      "--execute", "--confirm", RULE]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("result: done");
    expect(result.stdout).toContain("status: 201");
    const calls = records("requests.jsonl");
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "PUT"]);
    expect(calls.at(-1)).toEqual({ method: "PUT", url: RULE_URL,
      body: { name: RULE, properties: {
        protocol: "Tcp", sourcePortRange: "*", destinationPortRange: "23",
        sourceAddressPrefix: "*", destinationAddressPrefix: "*",
        access: "Deny", priority: 400, direction: "Outbound",
      } } });
    expect(records("writes.log")).toEqual([expect.objectContaining({ class: "destructive", method: "PUT",
      url: RULE_URL, outcome: "success", httpStatus: 201, requestId: "req-test" })]);
    expect(readFileSync(join(dir, "writes.log"), "utf8")).not.toMatch(/offline-nsg-token|"body"|"headers"|"properties"/);
  });

  it("sends plural selectors when several values are given", () => {
    const result = cli(["--destination-port-ranges", "23", "80-90", "--source-address-prefixes", "10.0.0.0/8", "Internet",
      "--execute", "--confirm", RULE]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(records("requests.jsonl").at(-1)).toMatchObject({ method: "PUT",
      body: { properties: {
        destinationPortRanges: ["23", "80-90"],
        sourceAddressPrefixes: ["10.0.0.0/8", "Internet"],
      } } });
  });

  it("polls a 202 operation to completion through the shared LRO handling", () => {
    const result = cli(["--execute", "--confirm", RULE], { scenario: "async" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("result: done");
    expect(records("writes.log")).toEqual([expect.objectContaining({ outcome: "success" })]);
  });

  it("returns acceptance with --no-wait instead of polling", () => {
    const result = cli(["--execute", "--confirm", RULE, "--no-wait"], { scenario: "async" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("result: operation accepted");
    expect(result.stdout).toContain("op status");
  });

  it.each([{ flags: [] as string[] }, { flags: ["--execute", "--confirm", "allow-HTTPS"] }])("refuses an existing name with $flags and sends no PUT", ({ flags }) => {
    const result = cli(flags, { name: "allow-HTTPS" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("VALIDATION_ERROR");
    expect(result.stdout).toContain("refusing to overwrite existing rule 'allow-https'");
    expect(records("requests.jsonl")).toEqual([{ method: "GET", url: NSG_URL }]);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([{ flags: [] as string[] }, { flags: ["--execute", "--confirm", RULE] }])("refuses an existing priority with $flags and sends no PUT", ({ flags }) => {
    const result = cli(flags, { priority: "200" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("VALIDATION_ERROR");
    expect(result.stdout).toContain("priority 200 is already used by rule 'deny-ssh'");
    expect(records("requests.jsonl")).toEqual([{ method: "GET", url: NSG_URL }]);
    expect(records("writes.log")).toEqual([]);
  });

  it("refuses a rule created after the preview instead of overwriting it", () => {
    const result = cli(["--execute", "--confirm", RULE], { ruleExists: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("CONFLICT");
    expect(result.stdout).toContain("created after the preview");
    expect(records("requests.jsonl").map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    { flags: ["--access", "Allow"], output: "--access takes Deny alone" },
    { flags: ["--access", "allow"], output: "--access takes Deny alone" },
    { flags: ["--priority", "99"], priority: null, output: "--priority must be an integer 100-4096" },
    { flags: ["--priority", "4097"], priority: null, output: "--priority must be an integer 100-4096" },
    { flags: ["--priority", "many"], priority: null, output: "--priority must be an integer 100-4096" },
    { flags: ["--direction", "Sideways"], output: "--direction must be Inbound or Outbound" },
    { flags: ["--protocol", "Gre"], output: "--protocol must be Tcp, Udp, Icmp, Esp, Ah or *" },
    { flags: ["--destination-port-ranges", "http"], output: "must be * or a port or range" },
    { flags: ["--description", "x".repeat(141)], output: "restricted to 140 chars" },
    { flags: ["--source-asgs", "asg-app"], output: "unknown flag" },
  ])("refuses $flags before transport or audit", ({ flags, priority, output }) => {
    const result = cli(flags, { priority: priority as string | null | undefined });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(output);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it("requires --confirm for execution and the exact rule name", () => {
    const missing = cli(["--execute"]);
    expect(missing.status).toBe(2);
    expect(missing.stdout).toContain("code: CONFIRM_REQUIRED");
    expect(missing.stdout).toContain(`--confirm '${RULE}'`);
    const mismatch = cli(["--execute", "--confirm", "other-rule"]);
    expect(mismatch.status).toBe(2);
    expect(mismatch.stdout).toContain("code: CONFIRM_MISMATCH");
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    { options: { nsgName: null, group: "rg-demo" }, extra: [] as string[], output: "--nsg-name with --resource-group" },
    { options: { nsgName: "nsg-web", group: null }, extra: [] as string[], output: "--nsg-name with --resource-group" },
    { options: {}, extra: ["--nsg-name", "nsg-web"], ids: true, output: "--ids selects the NSG itself" },
  ])("refuses NSG selection %j before transport or audit", ({ options, extra, ids, output }) => {
    const result = cli(extra, { nsgName: options.nsgName as string | null | undefined, group: options.group as string | null | undefined, ids });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("VALIDATION_ERROR");
    expect(result.stdout).toContain(output);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it.each([
    { ids: "/subscriptions/not-a-scope", output: "--ids must be one NSG ARM ID" },
    { ids: `/subscriptions/${OTHER}/resourceGroups/rg-demo/providers/Microsoft.Network/networkSecurityGroups/nsg-web`, output: "--ids conflicts with --subscription" },
  ])("refuses a malformed --ids $ids before transport or audit", ({ ids, output }) => {
    const result = cli(["--ids", ids], { nsgName: null, group: null });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("VALIDATION_ERROR");
    expect(result.stdout).toContain(output);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it("reports a missing NSG from the preview without a write", () => {
    const result = cli([], { nsgMissing: true });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("NOT_FOUND");
    expect(records("requests.jsonl")).toEqual([{ method: "GET", url: NSG_URL }]);
    expect(records("writes.log")).toEqual([]);
  });

  it("reports a failed PUT and audits the failure", () => {
    const result = cli(["--execute", "--confirm", RULE], { scenario: "precondition" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PRECONDITION_FAILED");
    expect(records("writes.log")).toEqual([expect.objectContaining({ class: "destructive", method: "PUT",
      url: RULE_URL, outcome: "PRECONDITION_FAILED", httpStatus: 412 })]);
  });

  describe.each([{ flags: [] as string[] }, { flags: ["--execute", "--confirm", RULE] }])("subscription validation with $flags", ({ flags }) => {
    it.each(["Example", "not-a-guid", null])("refuses subscription %s before transport or audit", (subscription) => {
      const result = cli(flags, { subscription });
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("VALIDATION_ERROR");
      expect(records("requests.jsonl")).toEqual([]);
      expect(records("writes.log")).toEqual([]);
    });
  });

  it.each([
    ["reader", "", [], "WRITES_DISABLED"],
    ["writer", "1", [], "WRITES_DISABLED"],
    ["writer", "", ["--execute", "--confirm", RULE, "--body", "{}"], "UNKNOWN_FLAG"],
    ["writer", "", ["--execute", "--confirm", RULE, "--management-group", "example-mg"], "VALIDATION_ERROR"],
  ])("refuses %s %s %j before transport or audit", (profile, readOnly, extra, code) => {
    const result = cli(["--priority", "400", ...extra], { profile, readOnly });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`code: ${code}`);
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it("refuses a subscription outside the profile allowlist", () => {
    const result = cli(["--execute", "--confirm", RULE], { subscription: OTHER });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code: SUBSCRIPTION_NOT_WRITABLE");
    expect(records("requests.jsonl")).toEqual([]);
    expect(records("writes.log")).toEqual([]);
  });

  it("decodes the preview output with the shared TOON contract", () => {
    const result = cli([]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(decode(result.stdout)).toMatchObject({
      dryRun: true, class: "destructive", method: "PUT", subscription: SUB, nsg: "nsg-web",
      totalRules: 2,
      rule: { name: RULE, properties: { access: "Deny", priority: 400, direction: "Inbound" } },
    });
  });
});
