import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/client.js", () => ({ request: vi.fn(), requestAll: vi.fn() }));
import { request, requestAll } from "../src/lib/client.js";
import { run } from "../src/commands/resource.js";
import { discoveryResource, SUB_A } from "./samples.js";

describe("resource show resolution", () => {
  it("returns only approved envelope metadata in the full view", async () => {
    vi.mocked(request).mockReset();
    const item = { ...discoveryResource, kind: "example", sku: { name: "Standard" },
      identity: { type: "SystemAssigned", principalId: "private-principal", userAssignedIdentities: { private: {} } },
      extra: "private-extra", properties: { provisioningState: "Succeeded", detail: "private-detail" },
    };
    vi.mocked(request).mockResolvedValue(item);
    expect((await run(["show", "--ids", item.id, "--subscription", SUB_A, "--api-version", "2025-01-01", "--full"])).resource).toEqual({
      id: item.id, name: item.name, type: item.type, kind: item.kind, location: item.location,
      tags: item.tags, sku: item.sku, identity: { type: "SystemAssigned" }, provisioningState: "Succeeded",
    });
    expect((await run(["show", "--ids", item.id, "--subscription", SUB_A, "--api-version", "2025-01-01", "--fields", "identity,provisioningState"])).resource).toEqual({
      identity: { type: "SystemAssigned" }, provisioningState: "Succeeded",
    });
  });
  describe.each(["name", "ids"])("%s selectors", (selector) => {
    it.each([
      ["listKeys", "Microsoft.Compute/virtualMachines"],
      ["LISTKEYS", "Microsoft.Compute/virtualMachines"],
      ["listKeys/listSecrets", "Microsoft.Compute/virtualMachines/extensions"],
      ["vm1/listKeys", "Microsoft.Compute/virtualMachines/extensions"],
    ])("shows resource names resembling credential actions: %s", async (name, type) => {
      vi.mocked(request).mockReset();
      vi.mocked(requestAll).mockClear();
      const [namespace, ...types] = type.split("/");
      const names = name.split("/");
      const id = `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/${namespace}/${types.map((t, i) => `${t}/${names[i]}`).join("/")}`;
      const item = { ...discoveryResource, id, name, type };
      vi.mocked(request).mockResolvedValue(item);
      const flags = selector === "ids" ? ["--ids", id] : ["--name", name, "--resource-group", "rg-demo", "--resource-type", type];
      expect((await run(["show", "--subscription", SUB_A, ...flags, "--api-version", "2025-01-01"])).resource).toMatchObject({ id, name });
      expect(request).toHaveBeenCalledWith(expect.anything(), { method: "GET", path: id, apiVersion: "2025-01-01" });
      expect(requestAll).not.toHaveBeenCalled();
    });
    it.each([
      ["CPU High", "rg-demo", "Microsoft.Insights/metricAlerts"],
      ["警告", "開発", "Microsoft.Insights/metricAlerts"],
      ["CPU High", "開発", "Microsoft.Insights/metricAlerts"],
      ["vm one/拡張", "rg-demo", "Microsoft.Compute/virtualMachines/extensions"],
    ])("encodes raw segments once for %s in %s", async (name, group, type) => {
      vi.mocked(request).mockReset();
      vi.mocked(requestAll).mockClear();
      const [namespace, ...types] = type.split("/");
      const names = name.split("/");
      const id = `/subscriptions/${SUB_A}/resourceGroups/${group}/providers/${namespace}/${types.map((t, i) => `${t}/${names[i]}`).join("/")}`;
      const item = { ...discoveryResource, id, name, type };
      vi.mocked(request).mockResolvedValueOnce({ resourceTypes: [{ resourceType: types.join("/"), apiVersions: ["2025-01-01"] }] }).mockResolvedValueOnce(item);
      const flags = selector === "ids" ? ["--ids", id] : ["--name", name, "--resource-group", group, "--resource-type", type];
      expect((await run(["show", "--subscription", SUB_A, ...flags])).resource).toMatchObject({ id, name });
      expect(request).toHaveBeenLastCalledWith(expect.anything(), { method: "GET", path: id.split("/").map(encodeURIComponent).join("/"), apiVersion: "2025-01-01" });
      expect(requestAll).not.toHaveBeenCalled();
    });
  });
  it("resolves a name to an ID and selects the newest stable provider version", async () => {
    vi.mocked(requestAll).mockClear();
    vi.mocked(requestAll).mockResolvedValue({ items: [discoveryResource] });
    vi.mocked(request).mockResolvedValueOnce({ resourceTypes: [{ resourceType: "virtualMachines", apiVersions: ["2026-01-01-preview", "2025-01-01", "2024-01-01"] }] }).mockResolvedValueOnce(discoveryResource);
    const result = await run(["show", "--subscription", SUB_A, "--name", "vm1", "--resource-group", "rg-demo", "--resource-type", "Microsoft.Compute/virtualMachines"]);
    expect(result.resource).toMatchObject({ id: discoveryResource.id });
    expect(request).toHaveBeenLastCalledWith(expect.anything(), { method: "GET", path: discoveryResource.id, apiVersion: "2025-01-01" });
    expect(requestAll).not.toHaveBeenCalled();
  });
  it.each([
    ["--ids", "https://example.com/secret"],
    ["--ids", discoveryResource.id + "/listKeys"],
    ["--ids", discoveryResource.id + "/listKeys/default"],
    ["--name", "vm1/default", "--resource-group", "rg-demo", "--resource-type", "Microsoft.Compute/virtualMachines/listKeys"],
    ["--ids", discoveryResource.id + "?x=y"],
    ["--ids", discoveryResource.id + "%20"],
    ["--name", "CPU%20High", "--resource-group", "rg-demo", "--resource-type", "Microsoft.Insights/metricAlerts"],
    ["--name", "vm1/..", "--resource-group", "rg-demo", "--resource-type", "Microsoft.Compute/virtualMachines/extensions"],
    ["--ids", discoveryResource.id + "/secrets/password"],
    ["--ids", discoveryResource.id + "/config/appsettings", "--fields", "id"],
    ["--ids", `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Automation/automationAccounts/demo/variables/password`, "--api-version", "2024-10-23"],
    ["--ids", `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.AppConfiguration/configurationStores/demo/keyValues/password`, "--full"],
    ["--name", "demo/password", "--resource-group", "rg-demo", "--resource-type", "Microsoft.Automation/automationAccounts/connections"],
    ["--ids", `/subscriptions/${SUB_A}/resourceGroups/../providers/Microsoft.Compute/virtualMachines/vm1`, "--api-version", "2024-07-01"],
    ["--ids", discoveryResource.id, "--name", "vm1"],
    ["--name", "vm1", "--resource-group", "rg-demo"],
  ])("refuses unsafe or conflicting selectors %j before transport", async (...flags) => {
    vi.mocked(request).mockClear(); vi.mocked(requestAll).mockClear();
    await expect(run(["show", ...flags])).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled(); expect(requestAll).not.toHaveBeenCalled();
  });
  it("refuses provider metadata without a stable version before resource retrieval", async () => {
    vi.mocked(request).mockReset();
    vi.mocked(request).mockResolvedValue({ resourceTypes: [{ resourceType: "virtualMachines", apiVersions: ["2026-01-01-preview"] }] });
    await expect(run(["show", "--ids", discoveryResource.id, "--subscription", SUB_A])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["Microsoft.Compute", "Microsoft.Compute/virtualMachines/extensions"])("refuses incomplete resource type/name pairs %s", async (type) => {
    vi.mocked(request).mockClear(); vi.mocked(requestAll).mockClear();
    await expect(run(["show", "--subscription", SUB_A, "--name", "vm1", "--resource-group", "rg-demo", "--resource-type", type])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(request).not.toHaveBeenCalled();
    expect(requestAll).not.toHaveBeenCalled();
  });
});
