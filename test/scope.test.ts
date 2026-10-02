import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/client.js", () => ({ requestAll: vi.fn() }));

import { requestAll } from "../src/lib/client.js";
import {
  clearSubscriptionCache,
  parseSubscriptionId,
  shortenResourceId,
  subscriptionNameMap,
} from "../src/lib/scope.js";
import type { ResolvedProfile } from "../src/lib/config.js";

const SUB = "00000000-0000-0000-0000-000000000020";
const RG = "rg-demo";
const VM_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Compute/virtualMachines/vm1`;

const profile = (overrides: Partial<ResolvedProfile> = {}): ResolvedProfile => ({
  name: "test",
  source: "implicit",
  auth: "token",
  writeSubscriptions: [],
  ...overrides,
});

beforeEach(() => {
  clearSubscriptionCache();
  vi.mocked(requestAll).mockReset();
});

afterEach(() => {
  clearSubscriptionCache();
});

describe("parseSubscriptionId", () => {
  it("extracts the subscription id when present", () => {
    expect(parseSubscriptionId(VM_ID)).toBe(SUB);
    expect(parseSubscriptionId(`/subscriptions/${SUB}`)).toBe(SUB);
    expect(parseSubscriptionId("/providers/Microsoft.Management/managementGroups/mg")).toBeUndefined();
    expect(parseSubscriptionId("not-an-id")).toBeUndefined();
  });
});

describe("shortenResourceId", () => {
  it("shortens the documented vm example with a subscription name", () => {
    const names = new Map([[SUB.toLowerCase(), "sandbox"]]);
    expect(shortenResourceId(VM_ID, names)).toBe(`sandbox/${RG}/vm/vm1`);
  });

  it("falls back to the raw subscription id without a name map", () => {
    expect(shortenResourceId(VM_ID)).toBe(`${SUB}/${RG}/vm/vm1`);
  });

  it("shortens subscription and resource group scopes", () => {
    expect(shortenResourceId(`/subscriptions/${SUB}`)).toBe(SUB);
    expect(shortenResourceId(`/subscriptions/${SUB}/resourceGroups/${RG}`)).toBe(`${SUB}/${RG}`);
  });

  it("keeps type and name for subscription-level resources", () => {
    const assignment = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleAssignments/ra1`;
    expect(shortenResourceId(assignment)).toBe(`${SUB}/roleAssignments/ra1`);
    const names = new Map([[SUB.toLowerCase(), "sandbox"]]);
    expect(shortenResourceId(assignment, names)).toBe("sandbox/roleAssignments/ra1");
  });

  it("abbreviates common types and keeps unknown types as-is", () => {
    const st = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/stdemo`;
    expect(shortenResourceId(st)).toBe(`${SUB}/${RG}/st/stdemo`);
    const custom = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Contoso.Widgets/widgets/w1`;
    expect(shortenResourceId(custom)).toBe(`${SUB}/${RG}/widgets/w1`);
  });

  it("keeps child resource segments", () => {
    const ext = `${VM_ID}/extensions/ext1`;
    expect(shortenResourceId(ext)).toBe(`${SUB}/${RG}/vm/vm1/extensions/ext1`);
  });

  it("passes non-ARM strings through unchanged", () => {
    for (const id of ["", "vm1", "/providers/Microsoft.Management/managementGroups/mg", "https://example.com/x"]) {
      expect(shortenResourceId(id)).toBe(id);
    }
  });
});

describe("subscriptionNameMap", () => {
  it("maps ids to display names and caches per process", async () => {
    vi.mocked(requestAll).mockResolvedValue({
      items: [{ subscriptionId: SUB, displayName: "Sandbox" }],
    });
    const first = await subscriptionNameMap(profile());
    expect(first.get(SUB.toLowerCase())).toBe("Sandbox");
    expect(requestAll).toHaveBeenCalledTimes(1);
    expect(await subscriptionNameMap(profile())).toBe(first);
    expect(requestAll).toHaveBeenCalledTimes(1);
  });

  it("never throws when ARM is unreachable", async () => {
    vi.mocked(requestAll).mockRejectedValue(new Error("boom"));
    expect(await subscriptionNameMap(profile())).toEqual(new Map());
  });
});
