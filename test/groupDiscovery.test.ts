import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn(), requestAll: vi.fn() }));
import { request, requestAll } from "../src/lib/client.js";
import { run as group } from "../src/commands/group.js";
import { run as resource } from "../src/commands/resource.js";
import { discoveryGroup, discoveryResource, SUB_A, SUB_B, subscriptionList } from "./samples.js";

let dir: string;
const all = vi.mocked(requestAll);
const get = vi.mocked(request);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-discovery-"));
  vi.stubEnv("AZ_AXI_CONFIG", join(dir, "config.json"));
  vi.stubEnv("AZ_AXI_PROFILE", "ci");
  vi.stubEnv("AZ_AXI_SUBSCRIPTION", "");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token", subscriptions: [SUB_A] } } }));
  all.mockReset(); get.mockReset();
  all.mockImplementation(async (_profile, options) => ({ items: options.path === "/subscriptions" ? subscriptionList : options.path.endsWith("/resources") ? [discoveryResource] : [discoveryGroup] }));
  get.mockImplementation(async (_profile, options) => options.path.includes("/providers/") ? discoveryResource : discoveryGroup);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe.each([
  { kind: "group", run: group, sample: discoveryGroup },
  { kind: "resource", run: resource, sample: discoveryResource },
])("$kind discovery", ({ kind, run, sample }) => {
  it("lists compact metadata with complete counts and IDs", async () => {
    const result = await run(["list"]);
    expect(result.total).toBe(1);
    expect(result.count).toMatch(/^1 of 1/);
    expect(result.rows).toEqual([expect.objectContaining({ name: sample.name, id: sample.id, location: "westus" })]);
    expect(result.rows).not.toEqual([sample]);
    expect(all).toHaveBeenCalledWith(expect.objectContaining({ subscriptions: [SUB_A] }), expect.objectContaining({ method: "GET", apiVersion: "2021-04-01" }), 100);
  });
  it("returns requested metadata fields", async () => {
    expect((await run(["list", "--fields", "id,tags"])).rows).toEqual([{ id: sample.id, tags: sample.tags }]);
  });
  it("selects the same compact fields by name", async () => {
    const fields = kind === "group" ? "name,state" : "name,type";
    expect((await run(["list", "--fields", fields])).rows).toEqual([kind === "group" ? { name: "rg-demo", state: "Succeeded" } : { name: "vm1", type: "Microsoft.Compute/virtualMachines" }]);
  });
  it("expands full metadata and all fetched rows", async () => {
    all.mockResolvedValue({ items: [sample, sample] });
    expect((await run(["list", "--full", "--limit", "1"])).rows).toEqual([sample, sample]);
  });
  it("states empty results definitively", async () => {
    all.mockResolvedValue({ items: [] });
    expect(await run(["list"])).toMatchObject({ total: 0, rows: expect.stringMatching(/^0 .* found in selected subscriptions$/) });
  });
  it("marks capped pages as incomplete including empty filtered results", async () => {
    all.mockResolvedValue({ items: [], nextLink: "https://management.azure.com/next" });
    expect(await run(["list"])).toMatchObject({ total: "0+", count: expect.stringContaining("0+"), help: expect.arrayContaining([expect.stringContaining("lower bounds")]) });
  });
  it("resolves subscription names without changing the configured write allowlist", async () => {
    await run(["list", "--subscription", "Sandbox"]);
    expect(all).toHaveBeenLastCalledWith(expect.objectContaining({ writeSubscriptions: [SUB_A] }), expect.objectContaining({ path: expect.stringContaining(SUB_A) }), 100);
  });
  it.each(["Unknown", "Sandbox"])("refuses unknown or ambiguous subscription name %s", async (name) => {
    all.mockResolvedValue({ items: [subscriptionList[0]!, { ...subscriptionList[0]!, subscriptionId: SUB_B }] });
    await expect(run(["list", "--subscription", name])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(all).toHaveBeenCalledTimes(1);
  });
  it.each([["list", "--bogus"], ["list", "extra"], ["list", "--limit", "0"], ["list", "--limit", "1.5"], ["show"], ["list", "--management-group", "parent"]])("refuses invalid usage %j before transport", async (argv) => {
    await expect(run(argv)).rejects.toBeDefined();
    expect(all).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it("propagates ARM failures instead of returning a partial success", async () => {
    all.mockRejectedValue(new Error("forbidden"));
    await expect(run(["list"])).rejects.toThrow("forbidden");
  });
  it("shows compact and full detail", async () => {
    const flags = kind === "group" ? ["--name", "rg-demo"] : ["--ids", discoveryResource.id, "--api-version", "2025-01-01"];
    expect((await run(["show", ...flags]))[kind]).toMatchObject({ id: sample.id, name: sample.name });
    expect((await run(["show", ...flags, "--full"]))[kind]).toEqual(sample);
    expect((await run(["show", ...flags, "--fields", "id"]))[kind]).toEqual({ id: sample.id });
  });
});
