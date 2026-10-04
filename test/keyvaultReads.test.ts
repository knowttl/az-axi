import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/client.js", () => ({ requestKeyVaultMetadata: vi.fn() }));
import { requestKeyVaultMetadata } from "../src/lib/client.js";
import { run } from "../src/commands/keyvault.js";
import { routeArgv } from "../src/lib/router.js";
const read = vi.mocked(requestKeyVaultMetadata);
let dir: string;
const args = ["secret", "list", "--vault-name", "kvexample"];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-keyvault-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token" } } }));
  vi.stubEnv("AZ_AXI_CONFIG", join(dir, "config.json"));
  vi.stubEnv("AZ_AXI_PROFILE", "ci");
  read.mockReset().mockResolvedValue({ rows: [{ name: "example-secret", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z" }], truncated: false });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
describe("key vault read commands", () => {
  it("lists compact safe properties and a scoped next step", async () => {
    expect(await run(args)).toMatchObject({ vault: "kvexample", count: "1 secrets", secrets: [{ name: "example-secret", expiresOn: "2026-11-03T00:00:00.000Z" }], help: [expect.stringContaining("keyvault secret show --vault-name kvexample")] });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ auth: "token" }), expect.objectContaining({ kind: "secret", verb: "list", vault: "kvexample", limit: 50 }));
  });
  it("lists a minimal default schema and expands it only with --fields or --full", async () => {
    read.mockResolvedValue({ rows: [{ name: "example-secret", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z", created: "2026-10-04T00:00:00.000Z", contentType: "text/plain" }], truncated: false });
    expect((await run(args)).secrets).toEqual([{ name: "example-secret", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z" }]);
    expect((await run([...args, "--full"])).secrets).toEqual([{ name: "example-secret", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z", created: "2026-10-04T00:00:00.000Z", contentType: "text/plain" }]);
  });
  it.each(["secret", "key", "certificate"] as const)("%s show selects fields and full preserves the safe schema", async (kind) => {
    read.mockResolvedValue({ rows: [{ name: "example", enabled: true, expiresOn: "" }], truncated: false });
    expect(await run([kind, "show", "--vault-name", "kvexample", "--name", "example", "--fields", "name,enabled", "--full"]))
      .toEqual({ vault: "kvexample", [kind]: { name: "example", enabled: true } });
  });
  it("reports an explicit empty page and a missing object", async () => {
    read.mockResolvedValue({ rows: [], truncated: false });
    expect(await run(args)).toMatchObject({ count: "0 secrets", secrets: "0 secrets found in kvexample" });
    await expect(run(["secret", "show", "--vault-name", "kvexample", "--name", "missing"])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("does not claim a total when the service has more pages", async () => {
    read.mockResolvedValue({ rows: [], truncated: true });
    expect(await run([...args, "--profile", "ci"])).toMatchObject({ count: "0+ secrets", help: [expect.stringContaining("--limit 100")] });
  });
  it("passes an expiry window through and scopes the count", async () => {
    const result = await run([...args, "--expiring-within", "30d"]);
    expect(read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expiringWithinMs: 30 * 86_400_000 }));
    expect(result).toMatchObject({ count: "1 secrets expiring within 30d" });
  });
  it.each(["soon", "0d", "-3d", "P1D", "never"])("rejects an invalid expiry window %j before transport", async (window) => {
    await expect(run([...args, "--expiring-within", window])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["--account-key", "key"], ["--sas-token", "sas"], ["--connection-string", "connection"],
    ["--auth-mode", "key"], ["--file", "output"], ["--fields", "value"], ["--fields", "tags"],
    ["--fields", "key"], ["--execute"], ["--expiring-within", "30d", "--name", "x"],
    ["--limit", "0"], ["--limit", "1001"], ["--limit", "1.5"], ["--limit"],
  ])("rejects %j before transport", async (...flags) => {
    const target = flags.includes("--name") ? ["secret", "show", "--vault-name", "kvexample"] : args;
    await expect(run([...target, ...flags])).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects --expiring-within on show through routing", () => {
    expect(() => routeArgv(["keyvault", "secret", "show", "--vault-name", "kvexample", "--name", "x", "--expiring-within", "30d"]))
      .toThrow(expect.objectContaining({ code: "UNKNOWN_FLAG" }));
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["secret", "list"], ["secret", "show", "--vault-name", "kvexample"],
    ["key", "show"], ["certificate", "download"], ["secret", "set"], ["secret", "backup"],
    ["secret", "restore"], ["secret", "purge"], ["secret", "delete"], ["key", "export"],
  ])("rejects incomplete or value and mutation paths %j", async (...argv) => {
    await expect(run(argv)).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
  it("accepts -n for show and keeps dash-prefixed names intact for transport validation", async () => {
    await run(routeArgv(["keyvault", "secret", "show", "--vault-name", "kvexample", "-n", "example"]).argv.slice(1));
    expect(read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "example" }));
    read.mockClear();
    await run(routeArgv(["keyvault", "secret", "show", "--vault-name", "kvexample", "--name=-x"]).argv.slice(1));
    expect(read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "-x" }));
  });
});
