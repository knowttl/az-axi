import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig, resolveProfile, resolveSecret, saveConfig, validateSecretRef } from "../src/lib/config.js";
import { resolveCredential } from "../src/lib/auth.js";
import { redact, redactText } from "../src/lib/redact.js";
import { run as authStatus } from "../src/commands/auth.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-refs-"));
  for (const key of ["AZ_AXI_ARM_TOKEN", "AZ_AXI_LOGS_TOKEN", "AZ_AXI_GRAPH_TOKEN", "AZ_AXI_STORAGE_TOKEN", "AZ_AXI_VAULT_TOKEN", "AZ_AXI_REGISTRY_TOKEN", "AZ_AXI_TENANT_ID", "AZ_AXI_TENANT", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTIONS", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_MANAGEMENT_GROUP", "AZ_AXI_READ_ONLY"]) vi.stubEnv(key, undefined);
  vi.stubEnv("AZ_AXI_CONFIG", join(dir, "config.json"));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it.each([
  { env: "INVALID-NAME" }, { env: "" }, { env: "VALID", file: "/secret" }, { env: 1 },
  { file: "relative" }, { stored: false }, "inline-sensitive-value", null,
])("rejects malformed ref %j on config load without echoing its value", (ref) => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ version: 1, profiles: { ci: { auth: "token", armToken: ref } } }));
  expect(() => loadConfig(path)).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  expect(() => loadConfig(path)).not.toThrowError(/inline-sensitive-value|INVALID-NAME/);
});

it.each(["BAD-NAME", "", "1TOKEN"])("validates legacy env name %j on load", (env) => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ version: 1, profiles: { ci: { auth: "token", tokenEnv: { arm: env } } } }));
  expect(() => loadConfig(path)).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it.each(["password", "accountKey", "clientSecret", "tenant", "unknown"])("rejects unknown profile field %s without its value", (field) => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ version: 1, profiles: { ci: { auth: "token", [field]: "inline-sensitive-value" } } }));
  expect(() => loadConfig(path)).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  expect(() => loadConfig(path)).not.toThrowError(/inline-sensitive-value/);
});

it.each(["\\\\server\\share\\token", "\\\\?\\C:\\token", "C:relative", "/unix/path"])("rejects Windows non-drive secret path %s", (file) => {
  expect(() => validateSecretRef({ file }, "armToken", "win32")).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it("accepts local absolute Windows drive refs", () => {
  expect(() => validateSecretRef({ file: "C:\\private\\token" }, "armToken", "win32")).not.toThrow();
});

it("resolves BOM-prefixed private token files and rereads changes without persisting tokens", async () => {
  const file = join(dir, "arm");
  writeFileSync(file, "\uFEFFsynthetic-arm-bearer\r\n  ", { mode: 0o600 });
  saveConfig({ version: 1, profiles: { ci: { auth: "token", armToken: { file } } } });
  const profile = resolveProfile({ profile: "ci" });
  expect((await resolveCredential(profile, "arm")).header).toBe("Bearer synthetic-arm-bearer");
  writeFileSync(file, "replacement-arm-bearer\n");
  expect((await resolveCredential(profile, "arm")).header).toBe("Bearer replacement-arm-bearer");
});

it.skipIf(process.platform === "win32")("rejects an insecure secret ref before resolving its content", () => {
  const file = join(dir, "secret");
  writeFileSync(file, "sensitive"); chmodSync(file, 0o644);
  expect(() => resolveSecret({ file })).toThrowError(expect.objectContaining({ code: "CONFIG_INSECURE" }));
});

it("registers raw, JSON-escaped and URL-encoded secret forms", () => {
  const value = 'synthetic-secret="one/two"';
  vi.stubEnv("CUSTOM_BEARER", value);
  resolveSecret({ env: "CUSTOM_BEARER" });
  expect(redactText([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)].join(" "))).toBe("***redacted*** ***redacted*** ***redacted***");
  expect(redact({ message: `contains ${value}` })).toEqual({ message: "contains ***redacted***" });
});

it("reports token reference locations without exposing secret values or acquiring tokens", async () => {
  vi.stubEnv("CUSTOM_BEARER", "synthetic-status-bearer");
  const file = join(dir, "logs");
  writeFileSync(file, "synthetic-logs-bearer", { mode: 0o600 });
  saveConfig({ version: 1, profiles: { ci: { auth: "token", armToken: { env: "CUSTOM_BEARER" }, logsToken: { file } } } });
  const status = await authStatus(["status", "--profile", "ci"]);
  expect(status).toMatchObject({ profile: "ci", auth: "token", sources: expect.arrayContaining([
    { resource: "arm", kind: "env", location: "CUSTOM_BEARER", available: true },
    { resource: "logs", kind: "file", location: file, available: true },
  ]) });
  expect(JSON.stringify(status)).not.toMatch(/synthetic-status-bearer|synthetic-logs-bearer/);
});

it("selects env auth before a default profile and ignores env profile fields for explicit selection", () => {
  saveConfig({ version: 1, defaultProfile: "work", profiles: { work: { auth: "az", tenantId: "file-tenant" } } });
  vi.stubEnv("AZ_AXI_TENANT_ID", "env-tenant");
  expect(resolveProfile()).toMatchObject({ name: "env", auth: "az", tenantId: "env-tenant" });
  vi.stubEnv("AZ_AXI_PROFILE", "work");
  expect(resolveProfile()).toMatchObject({ name: "work", tenantId: "file-tenant" });
});

it.each([
  { AZ_AXI_LOGS_TOKEN: "synthetic-logs-only" },
  { AZ_AXI_ARM_TOKEN: "synthetic-arm", AZ_AXI_TENANT_ID: "mixed" },
  { AZ_AXI_SUBSCRIPTION: "partial" },
])("rejects mixed or partial env profile %j", (env) => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  expect(() => resolveProfile()).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it("uses canonical env subscriptions before the deprecated alias", () => {
  vi.stubEnv("AZ_AXI_TENANT_ID", "env-tenant");
  vi.stubEnv("AZ_AXI_SUBSCRIPTIONS", "canonical-one,canonical-two");
  vi.stubEnv("AZ_AXI_SUBSCRIPTION", "deprecated");
  const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(resolveProfile()).toMatchObject({ subscriptions: ["canonical-one", "canonical-two"] });
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("AZ_AXI_SUBSCRIPTION is deprecated"));
});

it.each(["", "no", "yes", "2"])("fails closed for invalid read-only value %j", (value) => {
  vi.stubEnv("AZ_AXI_READ_ONLY", value);
  expect(() => resolveProfile()).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
});

it("reports stored refs as unavailable because az-axi has no credential store", () => {
  expect(() => resolveSecret({ stored: true })).toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }));
});
