import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUB_A, SUB_B, TENANT, azResourceGroup } from "./samples.js";

const probes = [["version", "--output", "json"], ["cloud", "show", "--output", "json"], ["account", "show", "--output", "json"]];
const read = ["group", "show", "--name", "rg-demo", "--subscription", SUB_A, "--output", "json"];
const args = ["az", "group", "show", "--name", "rg-demo", "--subscription", SUB_A];
let dir: string;
let responses: Record<string, unknown>;
let profile: Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-passthrough-"));
  copyFileSync(resolve("test/fixtures/az-passthrough.mjs"), join(dir, "az.mjs"));
  if (process.platform === "win32") {
    writeFileSync(join(dir, "az.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0az.mjs" %*\r\n`);
  } else {
    copyFileSync(resolve("test/fixtures/az-passthrough.mjs"), join(dir, "az"));
    chmodSync(join(dir, "az"), 0o755);
  }
  profile = { auth: "az", tenant: TENANT, subscriptions: [SUB_A] };
  responses = {
    version: { "azure-cli": "2.90.0", "azure-cli-core": "2.90.0", extensions: {} },
    "cloud show": { name: "AzureCloud", profile: "latest", endpoints: { resourceManager: "https://management.azure.com/" } },
    "account show": { id: SUB_A, tenantId: TENANT, environmentName: "AzureCloud", state: "Enabled", user: { name: "ada@contoso.com", type: "user" } },
    "group show": azResourceGroup,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function invoke(argv = args, extraEnv: Record<string, string> = {}) {
  writeFileSync(join(dir, "responses.json"), JSON.stringify(responses));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ defaultProfile: "work", profiles: { work: profile } }));
  const env = { ...process.env, PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`, AZ_AXI_CONFIG: join(dir, "config.json"), AZURE_CONFIG_DIR: join(dir, "signed-in-context"), ...extraEnv };
  for (const key of ["AZ_AXI_PROFILE", "AZ_AXI_TENANT", "AZ_AXI_SUBSCRIPTION"]) if (!Object.hasOwn(extraEnv, key)) delete env[key as keyof typeof env];
  const result = spawnSync(process.execPath, ["dist/bin/az-axi.js", ...argv], { encoding: "utf8", env, timeout: 10_000 });
  const calls = existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const environments = existsSync(join(dir, "envs.jsonl")) ? readFileSync(join(dir, "envs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  expect(environments).toHaveLength(calls.length);
  expect(new Set(environments.map((child) => child.AZURE_EXTENSION_DIR)).size).toBe(calls.length);
  for (const child of environments) {
    expect(child).toEqual({
      AZURE_CONFIG_DIR: env.AZURE_CONFIG_DIR,
      AZURE_EXTENSION_DIR: expect.stringContaining("az-axi-extensions-"),
      AZURE_EXTENSION_SYS_DIR: child.AZURE_EXTENSION_DIR,
      AZURE_EXTENSION_DEV_SOURCES: "", AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no",
      AZURE_CORE_OUTPUT: "json", AZURE_CORE_COLLECT_TELEMETRY: "no", AZURE_CORE_ONLY_SHOW_ERRORS: "true",
      AZURE_CORE_DISABLE_CONFIRM_PROMPT: "1", "AZURE_AUTO-UPGRADE_ENABLE": "no", AZURE_LOGGING_ENABLE_LOG_FILE: "no", extensionFiles: [],
    });
    expect(existsSync(child.AZURE_EXTENSION_DIR)).toBe(false);
  }
  expect(result.stderr).toBe("");
  return { status: result.status, output: decode(result.stdout), calls };
}

describe("built CLI reviewed passthrough", () => {
  it("executes only exact fixed probes and the canonical catalogue argv and emits compact TOON", () => {
    const result = invoke();
    expect(result).toEqual({ status: 0, calls: [...probes, read], output: { resourceGroup: { id: azResourceGroup.id, name: "rg-demo", location: "westeurope", state: "Succeeded" } } });
  });
  it.each(["-n", "-g", "--resource-group"])("accepts catalogue alias %s without forwarding it", (alias) => {
    expect(invoke(["az", "group", "show", alias, "rg-demo", "--subscription", SUB_A]).calls).toEqual([...probes, read]);
  });
  it("returns envelope metadata and tags on --full", () => {
    expect(invoke([...args, "--full"]).output).toEqual({ resourceGroup: {
      id: azResourceGroup.id, name: "rg-demo", location: "westeurope", state: "Succeeded", tags: azResourceGroup.tags,
    } });
  });
  it.each([[], ["--full"]])("never returns an unreviewed raw properties blob with %j", (...flags) => {
    responses["group show"] = { ...azResourceGroup, properties: { provisioningState: "Succeeded", nested: { setting: "secret-value" } } };
    const result = invoke([...args, ...flags]);
    expect(result.status).toBe(0);
    expect(JSON.stringify(result.output)).not.toContain("secret-value");
    expect(result.output).toMatchObject({ resourceGroup: { state: "Succeeded" } });
  });
  it("projects --fields locally", () => {
    expect(invoke([...args, "--fields", "name,state"]).output).toEqual({ resourceGroup: { name: "rg-demo", state: "Succeeded" } });
  });
  it.each([
    { flags: [], expected: { id: azResourceGroup.id, name: "rg-demo", location: "westeurope", state: "Succeeded" } },
    { flags: ["--fields", "name,state"], expected: { name: "rg-demo", state: "Succeeded" } },
    { flags: ["--full"], expected: { id: azResourceGroup.id, name: "rg-demo", location: "westeurope", state: "Succeeded", tags: {} } },
  ])("normalizes empty tags in output mode $flags", ({ flags, expected }) => {
    responses["group show"] = { ...azResourceGroup, tags: null };
    expect(invoke([...args, ...flags])).toEqual({ status: 0, calls: [...probes, read], output: { resourceGroup: expected } });
    responses["group show"] = { ...azResourceGroup, tags: undefined };
    expect(invoke([...args, ...flags])).toEqual({ status: 0, calls: [...probes, read, ...probes, read], output: { resourceGroup: expected } });
  });
  it.each([
    { flags: [], expected: { id: azResourceGroup.id, name: "rg-demo", location: "westeurope", state: "Succeeded" } },
    { flags: ["--fields", "name,state"], expected: { name: "rg-demo", state: "Succeeded" } },
    { flags: ["--full"], expected: { id: azResourceGroup.id, name: "rg-demo", location: "westeurope", state: "Succeeded", tags: azResourceGroup.tags } },
  ])("matches group names case-insensitively in output mode $flags", ({ flags, expected }) => {
    const argv = ["az", "group", "show", "--name", "RG-DEMO", "--subscription", SUB_A];
    const requestedRead = ["group", "show", "--name", "RG-DEMO", "--subscription", SUB_A, "--output", "json"];
    expect(invoke([...argv, ...flags])).toEqual({ status: 0, calls: [...probes, requestedRead], output: { resourceGroup: expected } });
  });
  it.each([{ tags: [] }, { tags: "invalid" }, { tags: { owner: 1 } }, { name: null }, { name: "rg-other" }])("refuses malformed or mismatched group metadata %j", (change) => {
    responses["group show"] = { ...azResourceGroup, ...change };
    expect(invoke()).toMatchObject({ status: 2, calls: [...probes, read], output: { code: "VALIDATION_ERROR" } });
  });
  it("isolates inherited user, system and dev extension sources without changing the login directory", () => {
    expect(invoke(args, {
      AZURE_EXTENSION_DIR: "untrusted", AZURE_EXTENSION_SYS_DIR: "untrusted-system",
      AZURE_EXTENSION_DEV_SOURCES: "untrusted-dev", AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "yes_without_prompt",
      "AZURE_AUTO-UPGRADE_ENABLE": "yes", AZURE_LOGGING_ENABLE_LOG_FILE: "yes",
    })).toMatchObject({ status: 0, calls: [...probes, read] });
  });
  it.each([
    ["az", "group", "delete", "--name", "rg-demo", "--execute"],
    ["az", "group", "create"], ["az", "group", "list"], ["az", "extension", "list"],
    ["az", "account", "get-access-token"], ["az", "storage", "account", "keys", "list"],
    ["az", "keyvault", "secret", "show"], ["az", "aks", "get-credentials"],
    ["az", "acr", "credential", "show"], ["az", "webapp", "config", "appsettings", "list"],
    [...args, "--query", "name"], [...args, "--output", "json"], [...args, "--debug"], [...args, "--execute"],
    [...args, "--ids", "/subscriptions/x"], [...args, "--tenant", TENANT], [...args, "--limit", "1"],
    [...args, "-n", "rg-demo"], [...args, "--subscription", SUB_A], [...args, "positional"],
    ["az", "group", "show", "--name", "rg-demo"],
    ["az", "group", "show", "--name", "$(touch attack)", "--subscription", SUB_A],
    ["az", "group", "show", "--name", "rg-demo", "--subscription", "not-a-uuid"],
    [...args, "--fields", "secret"], [...args, "--full", "--fields", "name"],
  ])("refuses %j before any child execution", (...argv) => {
    expect(invoke(argv)).toMatchObject({ status: 2, calls: [], output: { code: "VALIDATION_ERROR" } });
  });
  it.each([
    { auth: "token" }, { tenant: undefined }, { subscriptions: [SUB_B] },
    { subscriptions: [SUB_A, SUB_B] }, { managementGroup: "root" },
  ])("refuses incompatible profile %j before probes", (change) => {
    profile = { ...profile, ...change };
    expect(invoke()).toMatchObject({ status: 2, calls: [] });
  });
  it("refuses environment scope overrides before probes", () => {
    expect(invoke(args, { AZ_AXI_SUBSCRIPTION: SUB_B })).toMatchObject({ status: 2, calls: [] });
  });
  it.each([
    { "azure-cli": "2.91.0" }, { "azure-cli-core": "2.91.0" }, { extensions: { untrusted: "1" } },
    { extensions: undefined },
  ])("refuses unsupported runtime %j after only the version probe", (change) => {
    responses.version = { ...(responses.version as object), ...change };
    expect(invoke()).toMatchObject({ status: 2, calls: probes.slice(0, 1) });
  });
  it.each([{ name: "AzureChinaCloud" }, { profile: "2019-03-01-hybrid" }, { endpoints: {} }])("refuses cloud mismatch %j without the requested read", (change) => {
    responses["cloud show"] = { ...(responses["cloud show"] as object), ...change };
    expect(invoke()).toMatchObject({ status: 2, calls: probes.slice(0, 2) });
  });
  it.each([{ tenantId: SUB_B }, { id: SUB_B }, { state: "Disabled" }, { environmentName: "AzureChinaCloud" }, { user: {} }])("refuses account mismatch %j without the requested read", (change) => {
    responses["account show"] = { ...(responses["account show"] as object), ...change };
    expect(invoke()).toMatchObject({ status: 2, calls: probes });
  });
  it.each(["not JSON", "x".repeat(1024 * 1024 + 1)])("translates invalid or excessive dependency output", (response) => {
    responses.version = response;
    expect(invoke()).toMatchObject({ status: 1, calls: probes.slice(0, 1), output: { code: "PASSTHROUGH_FAILED" } });
  });
  it("rejects a response for another scope", () => {
    responses["group show"] = { ...azResourceGroup, id: `/subscriptions/${SUB_B}/resourceGroups/rg-demo` };
    expect(invoke()).toMatchObject({ status: 2, calls: [...probes, read] });
  });
  it("never leaks raw child failure diagnostics", () => {
    responses.fail = "group show";
    const result = invoke();
    expect(result).toMatchObject({ status: 1, calls: [...probes, read], output: { code: "PASSTHROUGH_FAILED" } });
    expect(JSON.stringify(result.output)).not.toContain("secret-token");
  });
});
