import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { AZ_READ_CATALOGUE } from "../src/lib/azReadCatalogue.js";
import { assertNoCatalogueDrift } from "../src/commands/az.js";
import { buildCatalogue, classifyCandidate, renderCatalogue } from "../scripts/az-read-catalogue.mjs";

const sources = JSON.parse(readFileSync(new URL("../scripts/az-read-catalogue.sources.json", import.meta.url), "utf8"));
const entry = AZ_READ_CATALOGUE.entries[0];
const candidate = {
  command: entry.command, version: entry.runtime.version, extensions: [],
  handlerClass: entry.handlerClass, handler: entry.handler,
  operations: entry.operations, credentialReturning: false,
};

describe("pinned az read catalogue", () => {
  it("reproduces the reviewed data artifact from official source excerpts", () => {
    expect(buildCatalogue(sources)).toEqual(AZ_READ_CATALOGUE);
    expect(readFileSync(new URL("../src/lib/azReadCatalogue.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n"))
      .toBe(renderCatalogue(buildCatalogue(sources)));
    expect(classifyCandidate(candidate)).toEqual({ effect: "read" });
  });

  it.each([
    { command: "group list" },
    { command: "group delete" },
    { command: "group exists" },
    { command: "group show alias" },
    { version: "2.90.1" },
    { version: "2.90.0-dev" },
    { version: undefined },
    { extensions: ["resource-graph"] },
    { extensions: ["unknown-extension"] },
    { extensions: undefined },
    { handlerClass: "custom" },
    { handlerClass: "aaz" },
    { handlerClass: undefined },
    { handler: "azure.mgmt.resource.resources.operations#ResourceGroupsOperations.list" },
    { operations: [] },
    { operations: [{ ...entry.operations[0], method: "POST" }] },
    { operations: [{ ...entry.operations[0], apiVersion: "2025-01-01" }] },
    { operations: [{ ...entry.operations[0], path: "/unreviewed" }] },
    { operations: [...entry.operations, { method: "GET", path: "/unreviewed", apiVersion: "2024-11-01" }] },
  ])("classifies unknown command/runtime/extension/handler/operation %j as write/refusal", (change) => {
    expect(classifyCandidate({ ...candidate, ...change })).toMatchObject({ effect: "write", reason: expect.any(String) });
  });

  it.each([
    "storage account keys list", "storage account show-connection-string", "storage account generate-sas",
    "keyvault secret show", "keyvault secret download", "account get-access-token", "aks get-credentials",
    "acr credential show", "webapp config appsettings list", "webapp deployment list-publishing-profiles",
    "functionapp keys list", "search admin-key show", "cosmosdb keys list", "logic workflow callback-url list",
  ])("never promotes credential command %s despite a read verb or reviewed GET", (command) => {
    expect(classifyCandidate({ ...candidate, command })).toMatchObject({ effect: "write" });
  });

  it.each([true, undefined])("refuses credential-returning or unreviewed output %j", (credentialReturning) => {
    expect(classifyCandidate({ ...candidate, credentialReturning })).toMatchObject({ effect: "write" });
  });

  it("blocks a transitive credential operation before output filtering", () => {
    expect(classifyCandidate({ ...candidate, operations: [
      ...entry.operations, { method: "POST", path: "/storageAccounts/demo/listKeys", apiVersion: "2024-11-01" },
    ] })).toMatchObject({ effect: "write", reason: expect.stringContaining("credential") });
  });

  it.each(Object.keys(sources))("refuses unreviewed %s metadata until its pin is explicitly reviewed", (name) => {
    expect(() => buildCatalogue({ ...sources, [name]: { ...sources[name], text: `${sources[name].text}\ncustom_command('show', 'get_secret')` } }))
      .toThrow("classification is write/refusal");
  });

  it("refuses extension metadata rather than loading it", () => {
    expect(() => buildCatalogue({ ...sources, extension: { source: "file:///extension/__init__.py" } }))
      .toThrow("Unknown or missing metadata source");
  });

  it("records argument constraints, credentials and immutable provenance for every entry", () => {
    expect(entry.arguments).toEqual([
      expect.objectContaining({ flags: ["--name", "-n", "--resource-group", "-g"], required: true, occurrences: 1, maxLength: 90 }),
      expect.objectContaining({ flags: ["--subscription"], type: "uuid", required: true, occurrences: 1 }),
    ]);
    expect(entry.argumentPolicy).toMatchObject({ unknown: "refuse", positionals: "refuse", duplicateAliases: "refuse" });
    expect(entry.credentials).toMatchObject({ returns: "none", keyFallback: false });
    expect(entry.runtime).toMatchObject({ version: "2.90.0", sdkVersion: "24.0.0", extensions: [] });
    expect(entry.provenance).toHaveLength(6);
    for (const source of entry.provenance) {
      expect(source.source).toContain(`/blob/${source.commit}/`);
      expect(source.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(source.excerptSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("records what the catalogue was generated from and matches every entry runtime", () => {
    expect(AZ_READ_CATALOGUE.generatedFrom).toMatchObject({
      azureCliVersion: "2.90.0",
      azureCliCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
      sdkPackage: "azure-mgmt-resource",
      sdkVersion: "24.0.0",
    });
    for (const approved of AZ_READ_CATALOGUE.entries) {
      expect(approved.runtime.version).toBe(AZ_READ_CATALOGUE.generatedFrom.azureCliVersion);
    }
    expect(() => assertNoCatalogueDrift()).not.toThrow();
  });

  it.each([
    { ...AZ_READ_CATALOGUE, schemaVersion: 2 },
    { ...AZ_READ_CATALOGUE, generatedFrom: { ...AZ_READ_CATALOGUE.generatedFrom, azureCliVersion: "2.91.0" } },
    { ...AZ_READ_CATALOGUE, generatedFrom: undefined },
    { ...AZ_READ_CATALOGUE, entries: [{ ...entry, effect: "write" as const }] },
    { ...AZ_READ_CATALOGUE, entries: [{ ...entry, runtime: { ...entry.runtime, version: "2.91.0" } }] },
  ])("refuses catalogue drift %j before any probe or child execution", (catalogue) => {
    expect(() => assertNoCatalogueDrift(catalogue)).toThrow("version drift");
  });
});

// A maintenance run must not execute az, Python or an installed extension, even for discovery.
const guard = `import * as cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
  cp.default[name] = () => {throw new Error('unexpected child execution')};
}
syncBuiltinESMExports();
globalThis.fetch = () => {throw new Error('unexpected network request')};`;
const guardedArgs = ["--import", `data:text/javascript,${encodeURIComponent(guard)}`];

describe("offline catalogue maintenance and CLI boundary", () => {
  it.each(["--help", "--check"])("runs %s without network or arbitrary extension execution", (flag) => {
    const result = spawnSync(process.execPath, [...guardedArgs, "scripts/az-read-catalogue.mjs", flag], {
      encoding: "utf8", env: { ...process.env, AZURE_EXTENSION_DIR: "untrusted-extensions", AZ_AXI_READ_ONLY: "1" },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(decode(result.stdout)).toMatchObject(flag === "--check" ? { reads: 1, execution: "unavailable" } : { usage: expect.any(String) });
  });

  it("rejects generator flags that could load extension metadata", () => {
    const result = spawnSync(process.execPath, [...guardedArgs, "scripts/az-read-catalogue.mjs", "--extension", "untrusted"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(decode(result.stdout)).toMatchObject({ error: "Unknown flags or arguments" });
  });

  it("ships the catalogue through the build as data", async () => {
    const { AZ_READ_CATALOGUE: built } = await import("../dist/lib/azReadCatalogue.js");
    expect(built).toEqual(AZ_READ_CATALOGUE);
  });

  it("never enables passthrough writes through the built CLI", () => {
    const result = spawnSync(process.execPath, [...guardedArgs, "dist/bin/az-axi.js", "az", "group", "show", "--name", "demo", "--execute"], {
      encoding: "utf8", env: { ...process.env, AZ_AXI_READ_ONLY: "1" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(decode(result.stdout)).toMatchObject({ code: "VALIDATION_ERROR", error: expect.stringContaining("--execute") });
  });
});
