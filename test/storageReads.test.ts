import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/client.js", () => ({ requestStorageMetadata: vi.fn() }));
import { requestStorageMetadata } from "../src/lib/client.js";
import { run } from "../src/commands/storage.js";
import { routeArgv } from "../src/lib/router.js";
const read = vi.mocked(requestStorageMetadata);
let dir: string;
const args = ["blob", "list", "--account-name", "stexample", "--container-name", "example"];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-storage-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token" } } }));
  vi.stubEnv("AZ_AXI_CONFIG", join(dir, "config.json"));
  vi.stubEnv("AZ_AXI_PROFILE", "ci");
  read.mockReset().mockResolvedValue({ rows: [{ name: "example", lastModified: "date", etag: "etag", size: "42", blobType: "BlockBlob" }] });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
describe("storage read commands", () => {
  it("lists compact safe properties and a scoped next step", async () => {
    expect(await run(args)).toMatchObject({ account: "stexample", container: "example", count: "1 blobs", blobs: [{ name: "example", size: "42" }], help: [expect.stringContaining("storage blob show --account-name stexample --container-name example")] });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ auth: "token" }), expect.objectContaining({ kind: "blob", verb: "list", limit: 50 }));
  });
  it.each(["container", "blob"])("%s show selects fields and full preserves the safe schema", async (kind) => {
    const target = [kind, "show", "--account-name", "stexample", "--name", "example", ...(kind === "blob" ? ["--container-name", "example"] : [])];
    expect(await run([...target, "--fields", "name,etag", "--full"])).toEqual({ account: "stexample", [kind]: { name: "example", etag: "etag" } });
  });
  it("reports an explicit empty page", async () => {
    read.mockResolvedValue({ rows: [] });
    expect(await run(args)).toMatchObject({ count: "0 blobs", blobs: "0 blobs found in example" });
  });
  it("does not claim a total when a continuation exists", async () => {
    read.mockResolvedValue({ rows: [], nextMarker: "--unsafe marker'" });
    expect(await run([...args, "--prefix", "folder x", "--profile", "ci"])).toMatchObject({ count: "0+ blobs", nextMarker: "--unsafe marker'", help: [expect.stringContaining("--marker=")] });
  });
  it.each(["container", "blob"])("%s list preserves literal filters in requests and pagination hints", async (kind) => {
    read.mockResolvedValue({ rows: [], nextMarker: " next page " });
    const result = await run([kind, "list", "--account-name", "stexample", ...(kind === "blob" ? ["--container-name", "example"] : []), "--prefix", " report ", "--marker", " current page "]);
    expect(read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prefix: " report ", marker: " current page " }));
    expect(result.help).toEqual([expect.stringContaining("--prefix ' report ' --limit 50 --marker ' next page '")]);
  });
  it.each([" report ", " ", "-report"])("blob show preserves literal name %j through routing", async (name) => {
    await run(routeArgv(["storage", "blob", "show", "--account-name", "stexample", "--container-name", "example", `--name=${name}`]).argv.slice(1));
    expect(read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name }));
  });
  it.each([["--prefix"], ["--prefix", ""], ["--marker"], ["--marker", ""]])("rejects missing or empty literal values %j", async (...flags) => {
    await expect(run([...args, ...flags])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([[], [""]])("rejects missing or empty blob names %j", async (...values) => {
    await expect(run(["blob", "show", "--account-name", "stexample", "--container-name", "example", "--name", ...values])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["container", " "], ["blob", " "], ["container", "-reports"], ["blob", "-reports"],
    ["container", "--reports"], ["blob", "--reports"],
  ])("%s pagination preserves literal %j through shell and routing", async (kind, value) => {
    read.mockResolvedValue({ rows: [], nextMarker: value });
    const result = await run(routeArgv(["storage", kind, "list", "--account-name", "stexample", ...(kind === "blob" ? ["--container-name", "example"] : []), `--prefix=${value}`, `--marker=${value}`]).argv.slice(1));
    expect(read).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ prefix: value, marker: value }));
    const command = (result.help as string[])[0]!.split("`")[1]!;
    const argv = execFileSync("sh", ["-s"], { encoding: "utf8", input: `capture() { printf '%s\\0' "$@"; }; ${command.replace(/^az-axi /, "capture ")}` }).split("\0").slice(0, -1);
    await run(routeArgv(argv).argv.slice(1));
    expect(read).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ prefix: value, marker: value }));
  });
  it.each([
    ["storage", "blob", "list", "--account-name= "],
    ["storage", "blob", "list", "--account-name=stexample", "--container-name= "],
    ["storage", "container", "show", "--account-name=stexample", "--name= "],
    ["resource", "list", "--name= "],
  ])("keeps nonliteral routing validation for %j", (...argv) => {
    expect(() => routeArgv(argv)).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["container", "list", "next"], ["blob", "list", "next"],
    ["container", "show", undefined], ["blob", "show", undefined],
  ])("%s %s hints preserve selector whitespace through shell and routing", async (kind, verb, nextMarker) => {
    const config = join(dir, "config.json ");
    const profile = " ci ";
    const tenant = " tenant ";
    writeFileSync(config, JSON.stringify({ profiles: { [profile]: { auth: "token", tokenEnv: { storage: "EXPECTED_STORAGE_TOKEN" } } } }));
    read.mockResolvedValue({ rows: [{ name: "example", etag: "etag" }], nextMarker });
    const expectedProfile = { name: profile, tenant, configPath: config, tokenEnv: { storage: "EXPECTED_STORAGE_TOKEN" } };
    const result = await run(routeArgv(["storage", kind!, "list", "--account-name", "stexample", ...(kind === "blob" ? ["--container-name", "example"] : []), "--config", config, "--profile", profile, "--tenant", tenant]).argv.slice(1));
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining(expectedProfile), expect.objectContaining({ kind, verb: "list" }));
    const command = (result.help as string[])[0]!.split("`")[1]!.replace("<name>", "example");
    const argv = execFileSync("sh", ["-s"], { encoding: "utf8", input: `capture() { printf '%s\\0' "$@"; }; ${command.replace(/^az-axi /, "capture ")}` }).split("\0").slice(0, -1);
    await run(routeArgv(argv).argv.slice(1));
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining(expectedProfile), expect.objectContaining({ kind, verb }));
  });
  it.each([
    ["--auth-mode", "key"], ["--account-key", "key"], ["--sas-token", "sas"], ["--connection-string", "connection"],
    ["--file", "output"], ["--include", "metadata"], ["--fields", "metadata"], ["--execute"],
    ["--limit", "0"], ["--limit", "1001"], ["--limit", "1.5"], ["--limit"],
  ])("rejects %j before transport", async (...flags) => {
    await expect(run([...args, ...flags])).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["container", "list"], ["blob", "list", "--account-name", "stexample"], ["container", "show", "--account-name", "stexample"],
    ["blob", "download"], ["account", "keys", "list"],
  ])("rejects incomplete or credential/content paths %j", async (...argv) => {
    await expect(run(argv)).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
});
