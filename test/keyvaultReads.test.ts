import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, encode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/client.js", () => ({ requestKeyVaultMetadata: vi.fn() }));
import { requestKeyVaultMetadata } from "../src/lib/client.js";
import { run } from "../src/commands/keyvault.js";
import { routeArgv } from "../src/lib/router.js";
import { runCommand } from "../src/lib/registry.js";
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
    expect(await run(args)).toMatchObject({ vault: "kvexample", count: "1 secrets", secrets: [{ name: "example-secret", expiresOn: "2026-11-03T00:00:00.000Z" }], help: [expect.stringContaining("keyvault secret list --vault-name kvexample --limit 50 --full")] });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ auth: "token" }), expect.objectContaining({ kind: "secret", vault: "kvexample", limit: 50 }));
  });
  it("lists a minimal default schema and expands it only with --fields or --full", async () => {
    read.mockResolvedValue({ rows: [{ name: "example-secret", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z", created: "2026-10-04T00:00:00.000Z", contentType: "text/plain" }], truncated: false });
    expect((await run(args)).secrets).toEqual([{ name: "example-secret", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z" }]);
    expect((await run([...args, "--full"])).secrets).toEqual([{ name: "example-secret", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z", created: "2026-10-04T00:00:00.000Z", contentType: "text/plain" }]);
  });
  it.each([
    ["secret", "secrets"], ["key", "keys"], ["certificate", "certificates"],
  ] as const)("%s list selects safe fields in %s", async (kind, noun) => {
    read.mockResolvedValue({ rows: [{ name: "example", enabled: true, expiresOn: "" }], truncated: false });
    expect(await run([kind, "list", "--vault-name", "kvexample", "--fields", "name,enabled", "--full"]))
      .toEqual({ vault: "kvexample", count: `1 ${noun}`, [noun]: [{ name: "example", enabled: true }] });
  });
  it.each([
    ["secret", "secrets"], ["key", "keys"], ["certificate", "certificates"],
  ] as const)("%s empty output preserves its diagnostic and %s array through serialization", async (kind, noun) => {
    read.mockResolvedValue({ rows: [], truncated: false });
    expect(decode(encode(await runCommand("keyvault", [kind, "list", "--vault-name", "kvexample"]))))
      .toEqual({ vault: "kvexample", count: `0 ${noun}`, [noun]: [], status: `0 ${noun} found in kvexample` });
  });
  it("does not claim a total when the service has more pages", async () => {
    read.mockResolvedValue({ rows: [], truncated: true });
    expect(await run([...args, "--profile", "ci"])).toMatchObject({ count: "0+ secrets", help: [expect.stringContaining("--limit 100")] });
  });
  it.each([
    ["secret", "secrets"], ["key", "keys"], ["certificate", "certificates"],
  ] as const)("%s discloses an incomplete empty scan of %s through serialization", async (kind, noun) => {
    read.mockResolvedValue({ rows: [], truncated: true, truncationReason: "scan" });
    expect(decode(encode(await runCommand("keyvault", [kind, "list", "--vault-name", "kvexample", "--expiring-within", "30d"]))))
      .toMatchObject({
        count: `0+ ${noun} expiring within 30d`,
        [noun]: [],
        status: `No matching ${noun} in scanned pages of kvexample expiring within 30d; listing incomplete`,
        help: ["Listing stopped at the 40-page scan cap; increasing --limit cannot extend the scan"],
      });
  });
  it("reports partial rows when the scan cap stops a nonempty list", async () => {
    read.mockResolvedValue({ rows: [{ name: "example", enabled: true, expiresOn: "" }], truncated: true, truncationReason: "scan" });
    expect(await run(args)).toMatchObject({ count: "1+ secrets", secrets: [{ name: "example" }], help: [expect.stringContaining("40-page scan cap")] });
  });
  it("does not suggest raising the row limit beyond its maximum", async () => {
    read.mockResolvedValue({ rows: [{ name: "example" }], truncated: true, truncationReason: "limit" });
    expect(await run([...args, "--limit", "1000"]))
      .toMatchObject({ count: "1+ secrets", help: ["Listing incomplete at the maximum --limit of 1000"] });
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
    await expect(run([...args, ...flags])).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["secret", "key", "certificate"] as const)("%s show is rejected before transport", async (kind) => {
    const argv = [kind, "show", "--vault-name", "kvexample", "--name", "EXAMPLE"];
    expect(() => routeArgv(["keyvault", ...argv]))
      .toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    await expect(run(argv)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["secret", "list"], ["key", "list"], ["certificate", "download"], ["secret", "set"], ["secret", "backup"],
    ["secret", "restore"], ["secret", "purge"], ["secret", "delete"], ["key", "export"],
  ])("rejects incomplete or value and mutation paths %j", async (...argv) => {
    await expect(run(argv)).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["secret", "key", "certificate"] as const)("%s metadata hint runs as a list with the original scope", async (kind) => {
    const result = await run([kind, "list", "--vault-name", "kvexample", "--profile", "ci", "--limit", "30", "--expiring-within", "30d"]);
    const [hint] = result.help as string[];
    const argv = hint!.split("`")[1]!.split(" ").slice(1);
    await run(routeArgv(argv).argv.slice(1));
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ name: "ci" }), {
      kind, vault: "kvexample", limit: 30, expiringWithinMs: 30 * 86_400_000,
    });
  });
});
