import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn(), requestAll: vi.fn() }));
import { request, requestAll } from "../src/lib/client.js";
import { run as account } from "../src/commands/account.js";
import { run as monitor } from "../src/commands/monitor.js";
import { discoveryAccount, discoveryWorkspace, SUB_A, SUB_B, subscriptionList } from "./samples.js";

let dir: string;
const all = vi.mocked(requestAll);
const get = vi.mocked(request);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-workspace-account-unit-"));
  vi.stubEnv("AZ_AXI_CONFIG", join(dir, "config.json"));
  vi.stubEnv("AZ_AXI_PROFILE", "ci");
  vi.stubEnv("AZ_AXI_SUBSCRIPTION", "");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token", subscriptions: [SUB_A] } } }));
  all.mockReset(); get.mockReset();
  all.mockResolvedValue({ items: subscriptionList });
  get.mockResolvedValue(discoveryAccount);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("account and workspace discovery scope contracts", () => {
  it("uses environment selection without widening configured write subscriptions", async () => {
    vi.stubEnv("AZ_AXI_SUBSCRIPTION", SUB_B);
    expect(await account(["list"])).toMatchObject({ total: 1, subscriptions: [{ name: "Lab", id: SUB_B }] });
    expect(all).toHaveBeenCalledWith(expect.objectContaining({ subscriptions: [SUB_B], writeSubscriptions: [SUB_A] }), expect.objectContaining({ method: "GET", path: "/subscriptions" }), 100);
  });
  it("lets explicit selection override the environment", async () => {
    vi.stubEnv("AZ_AXI_SUBSCRIPTION", SUB_B);
    await account(["show", "--subscription", SUB_A]);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ subscriptions: [SUB_A] }), expect.objectContaining({ path: `/subscriptions/${SUB_A}` }));
    expect(all).not.toHaveBeenCalled();
  });
  it("requires a unique account when no subscription default exists", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token" } } }));
    await expect(account(["show"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(get).not.toHaveBeenCalled();
  });
  it("lists all accessible accounts when no subscription scope exists", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token" } } }));
    expect(await account(["list"])).toMatchObject({ total: 3 });
  });
  it("refuses name resolution against a capped subscription catalogue", async () => {
    all.mockResolvedValue({ items: subscriptionList, nextLink: "https://management.azure.com/next" });
    await expect(account(["list", "--subscription", "Sandbox"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(get).not.toHaveBeenCalled();
  });
  it("does not print unknown subscription fields in a full view", async () => {
    get.mockResolvedValue({ ...discoveryAccount, user: { password: "opaque-secret" }, customValue: "opaque-secret" });
    expect(JSON.stringify(await account(["show", "--full"]))).not.toContain("opaque-secret");
  });
  it("uses an ID's subscription for an unscoped workspace profile", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token" } } }));
    get.mockResolvedValue(discoveryWorkspace);
    await monitor(["log-analytics", "workspace", "show", "--ids", discoveryWorkspace.id]);
    expect(get).toHaveBeenCalledWith(expect.anything(), { method: "GET", path: discoveryWorkspace.id, apiVersion: "2025-07-01" });
    expect(all).not.toHaveBeenCalled();
  });
  it("filters workspace names case insensitively and expands all fetched rows", async () => {
    all.mockResolvedValue({ items: [discoveryWorkspace, { ...discoveryWorkspace, name: "other" }] });
    expect(await monitor(["log-analytics", "workspace", "list", "--name", "LOGS-DEMO"])).toMatchObject({ total: 1 });
    expect(await monitor(["log-analytics", "workspace", "list", "--full", "--limit", "1"])).toMatchObject({ count: "2 of 2 workspaces" });
  });
  it.each([account, (argv: string[]) => monitor(["log-analytics", "workspace", ...argv])])("refuses implicit management-group scope before transport", async (run) => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token", managementGroup: "root", subscriptions: [SUB_A] } } }));
    await expect(run(["list"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(all).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
