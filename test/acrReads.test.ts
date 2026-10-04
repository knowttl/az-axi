import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/client.js", () => ({ requestAcrMetadata: vi.fn() }));
import { requestAcrMetadata } from "../src/lib/client.js";
import { run } from "../src/commands/acr.js";
import { routeArgv } from "../src/lib/router.js";
import { acrDigest, acrMetadataRows } from "./samples.js";
const read = vi.mocked(requestAcrMetadata);
let dir: string;
const list = ["repository", "list", "--name", "myregistry"];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-acr-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token" } } }));
  vi.stubEnv("AZ_AXI_CONFIG", join(dir, "config.json"));
  vi.stubEnv("AZ_AXI_PROFILE", "ci");
  read.mockReset().mockResolvedValue({ rows: [{ name: "hello-world" }, { name: "nanoserver" }] });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
describe("acr read commands", () => {
  it("lists compact repository names and a scoped next step", async () => {
    expect(await run(list)).toMatchObject({ registry: "myregistry", count: "2 repositories",
      repositories: [{ name: "hello-world" }, { name: "nanoserver" }],
      help: [expect.stringContaining("acr repository show-tags --name myregistry")] });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ auth: "token" }),
      expect.objectContaining({ op: "repository-list", registry: "myregistry", limit: 50 }));
  });
  it("lists tags with digest metadata and a manifest next step", async () => {
    read.mockResolvedValue({ rows: [acrMetadataRows.tag] });
    const args = ["repository", "show-tags", "--name", "myregistry", "--repository", "hello-world", "--orderby", "time_desc"];
    expect(await run(args)).toMatchObject({ registry: "myregistry", repository: "hello-world", count: "1 tags",
      tags: [acrMetadataRows.tag], help: [expect.stringContaining("acr manifest show-metadata --registry myregistry")] });
    expect(read).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ op: "tag-list", orderby: "time_desc", limit: 50 }));
  });
  it("shows one manifest by tag and by digest", async () => {
    read.mockResolvedValue({ rows: [acrMetadataRows.manifest] });
    expect(await run(["manifest", "show-metadata", "--registry", "myregistry", "--name", "hello-world:latest"]))
      .toEqual({ registry: "myregistry", repository: "hello-world", reference: "latest", manifest: acrMetadataRows.manifest });
    expect(read).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ op: "manifest-show", repository: "hello-world", reference: "latest" }));
    await run(["manifest", "show-metadata", "--registry", "myregistry", "--name", `hello-world@${acrDigest}`]);
    expect(read).toHaveBeenLastCalledWith(expect.anything(),
      expect.objectContaining({ repository: "hello-world", reference: acrDigest }));
  });
  it.each([
    ["team/my--image:latest", "team/my--image", "latest"],
    [`team/my__image@${acrDigest}`, "team/my__image", acrDigest],
    ["hello-world:release.azurecr.io", "hello-world", "release.azurecr.io"],
    ["team.azurecr.io-tools:latest", "team.azurecr.io-tools", "latest"],
    [`team.azurecr.io-tools@${acrDigest}`, "team.azurecr.io-tools", acrDigest],
    ["team/image.azurecr.io:latest", "team/image.azurecr.io", "latest"],
    [`team/image.azurecr.io@${acrDigest}`, "team/image.azurecr.io", acrDigest],
    ["team.azurecr.io:latest", "team.azurecr.io", "latest"],
    [`team.azurecr.io@${acrDigest}`, "team.azurecr.io", acrDigest],
  ])("parses valid artifact %s", async (artifact, repository, reference) => {
    read.mockResolvedValue({ rows: [acrMetadataRows.manifest] });
    expect(await run(routeArgv(["acr", "manifest", "show-metadata", "--registry", "myregistry", "--name", artifact]).argv.slice(1)))
      .toMatchObject({ repository, reference, manifest: acrMetadataRows.manifest });
    expect(read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ repository, reference }));
  });
  it.each(["hello-world", "team.azurecr.io-tools", "team/image.azurecr.io"])("preserves explicit identity and config when following tags for %s to a manifest", async (repository) => {
    const config = join(dir, "selected config.json");
    writeFileSync(config, JSON.stringify({ profiles: { selected: { auth: "token" } } }));
    read.mockResolvedValue({ rows: [acrMetadataRows.tag] });
    const result = await run(["repository", "show-tags", "--name", "myregistry", "--repository", repository,
      "--profile", "selected", "--tenant", "selected-tenant", "--config", config]);
    const command = (result.help as string[])[0]!.split("`")[1]!.replace("<tag>", "latest");
    const argv = execFileSync("sh", ["-s"], { encoding: "utf8", input: `capture() { printf '%s\\0' "$@"; }; ${command.replace(/^az-axi /, "capture ")}` }).split("\0").slice(0, -1);
    read.mockResolvedValue({ rows: [acrMetadataRows.manifest] });
    await run(routeArgv(argv).argv.slice(1));
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ name: "selected", tenant: "selected-tenant", configPath: config }),
      expect.objectContaining({ op: "manifest-show", repository, reference: "latest" }));
  });
  it("reports an explicit empty page", async () => {
    read.mockResolvedValue({ rows: [] });
    expect(await run(list)).toMatchObject({ count: "0 repositories", repositories: "0 repositories found in myregistry" });
  });
  it("does not claim a total when a continuation exists", async () => {
    read.mockResolvedValue({ rows: [], nextMarker: "hello-world" });
    expect(await run([...list, "--profile", "ci"])).toMatchObject({ count: "0+ repositories",
      nextMarker: "hello-world", help: [expect.stringContaining("--marker hello-world")] });
  });
  it("preserves literal markers through shell and routing", async () => {
    read.mockResolvedValue({ rows: [], nextMarker: " next page " });
    const result = await run(routeArgv(["acr", "repository", "list", "--name", "myregistry", "--marker= next page "]).argv.slice(1));
    expect(read).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ last: " next page " }));
    const command = (result.help as string[])[0]!.split("`")[1]!;
    const argv = execFileSync("sh", ["-s"], { encoding: "utf8", input: `capture() { printf '%s\\0' "$@"; }; ${command.replace(/^az-axi /, "capture ")}` }).split("\0").slice(0, -1);
    await run(routeArgv(argv).argv.slice(1));
    expect(read).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ last: " next page " }));
  });
  it("selects safe fields and full preserves the safe schema", async () => {
    read.mockResolvedValue({ rows: [acrMetadataRows.tag] });
    const args = ["repository", "show-tags", "--name", "myregistry", "--repository", "hello-world"];
    expect(await run([...args, "--fields", "name,digest", "--full"])).toMatchObject({ tags: [{ name: "latest", digest: acrDigest }] });
    read.mockResolvedValue({ rows: [acrMetadataRows.manifest] });
    expect(await run(["manifest", "show-metadata", "--registry", "myregistry", "--name", "hello-world:latest", "--fields", "digest"]))
      .toMatchObject({ manifest: { digest: acrDigest } });
  });
  it.each([
    ["--username", "user"], ["--password", "secret"], ["--account-key", "key"], ["--sas-token", "sas"],
    ["--connection-string", "connection"], ["--suffix", "tenant"], ["--image", "hello-world:latest"],
    ["--file", "output"], ["--detail", "true"], ["--execute"], ["--top", "10"],
    ["--limit", "0"], ["--limit", "1001"], ["--limit", "1.5"], ["--limit"],
    ["--orderby", "newest"], ["--fields", "password"],
  ])("rejects %j before transport", async (...flags) => {
    await expect(run([...list, ...flags])).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects orderby and limits outside their leaves", async () => {
    await expect(run([...list, "--orderby", "time_desc"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(run(["manifest", "show-metadata", "--registry", "myregistry", "--name", "hello-world:latest", "--limit", "10"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["repository", "delete"], ["repository", "untag"], ["repository", "update"], ["repository", "show"],
    ["manifest", "delete"], ["manifest", "show"], ["manifest", "update-metadata"], ["manifest", "list"],
    ["login"], ["credential", "show"], ["repository", "list", "--name", "myregistry", "--repository", "extra"],
  ])("rejects write, credential and unknown paths %j", async (...argv) => {
    await expect(run(argv)).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    "hello-world", "hello-world:", ":latest", "myregistry.azurecr.io/hello-world:latest", "https://example.com/hello-world:latest",
    `myregistry.azurecr.io/hello-world@${acrDigest}`, `https://example.com/hello-world@${acrDigest}`,
  ])("rejects malformed or qualified artifacts %j", async (artifact) => {
    await expect(run(["manifest", "show-metadata", "--registry", "myregistry", "--name", artifact])).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["repository", "list"], ["repository", "show-tags", "--name", "myregistry"],
    ["manifest", "show-metadata", "--registry", "myregistry"],
  ])("rejects incomplete selectors %j", async (...argv) => {
    await expect(run(argv)).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
});
