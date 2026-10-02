import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), requestAll: vi.fn() }));

import { run } from "../src/commands/rbac.js";
import { requestAll, sendRequest } from "../src/lib/client.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import { CONTRIBUTOR_ROLE_ID, OWNER_ROLE_ID } from "../src/lib/roles.js";
import { RBAC_ASSIGNMENTS } from "../src/lib/queries.js";

const sendMock = vi.mocked(sendRequest);
const allMock = vi.mocked(requestAll);

const SYN = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const SUB_A = SYN(20);
const SUB_B = SYN(21);
const P1 = SYN(40);
const P2 = SYN(41);
const CUSTOM_ROLE = SYN(31);

const roleId = (guid: string) => `/providers/Microsoft.Authorization/roleDefinitions/${guid}`;

// source: authorizationresources table reference (identifiers replaced)
const row = (overrides: Record<string, unknown> = {}) => ({
  principalId: P1,
  principalType: "User",
  roleName: "Owner",
  roleDefinitionId: roleId(OWNER_ROLE_ID),
  scope: `/subscriptions/${SUB_A}`,
  createdOn: "2026-09-20T10:00:00.000Z",
  id: `/subscriptions/${SUB_A}/providers/Microsoft.Authorization/roleAssignments/${SYN(50)}`,
  subscriptionId: SUB_A,
  ...overrides,
});

const graphBody = () => [
  { principalId: P1, principalType: "User", roleName: "Owner", roleDefinitionId: roleId(OWNER_ROLE_ID), scope: `/subscriptions/${SUB_A}`, createdOn: "2026-09-20T10:00:00.000Z", id: "ra1", subscriptionId: SUB_A },
  { principalId: P2, principalType: "ServicePrincipal", roleName: "Reader", roleDefinitionId: roleId(CUSTOM_ROLE), scope: `/subscriptions/${SUB_A}/resourceGroups/rg-demo`, createdOn: "2026-09-19T10:00:00.000Z", id: "ra2", subscriptionId: SUB_A },
  { principalId: P1, principalType: "User", roleName: "Contributor", roleDefinitionId: roleId(CONTRIBUTOR_ROLE_ID), scope: `/subscriptions/${SUB_B}`, createdOn: "2026-09-18T10:00:00.000Z", id: "ra3", subscriptionId: SUB_B },
];

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

function mockGraphNames() {
  sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
    if (options["resource"] === "graph") {
      if (options["method"] === "GET") {
        return { status: 200, headers: {}, body: { id: P1 }, clientRequestId: "g" } as never;
      }
      return {
        status: 200,
        headers: {},
        body: { value: [{ id: P1, displayName: "Analyst" }, { id: P2, displayName: "App" }] },
        clientRequestId: "g",
      } as never;
    }
    return { status: 200, headers: {}, body: { totalRecords: 3, count: 3, data: graphBody() }, clientRequestId: "r" } as never;
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-rbac-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  clearSubscriptionCache();
  sendMock.mockReset();
  allMock.mockReset();
  allMock.mockResolvedValue({ items: [{ subscriptionId: SUB_A, displayName: "Sandbox" }] });
  mockGraphNames();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
  clearSubscriptionCache();
});

function armBody() {
  const call = sendMock.mock.calls.find(([, options]) => (options as Record<string, unknown>)["resource"] !== "graph");
  return (call?.[1] as { body: Record<string, unknown> }).body;
}

describe("rbac list", () => {
  it("posts the canned query with scope precedence and formats rows", async () => {
    const result = await run(["list"]);
    const [, options] = sendMock.mock.calls.find(
      ([, o]) => (o as Record<string, unknown>)["resource"] !== "graph",
    ) as unknown as [unknown, { path: string; apiVersion: string; method: string }];
    expect(options.path).toBe("/providers/Microsoft.ResourceGraph/resources");
    expect(options.apiVersion).toBe("2024-04-01");
    expect(options.method).toBe("POST");
    expect(armBody()).toMatchObject({ query: RBAC_ASSIGNMENTS, options: { $top: 1000, resultFormat: "objectArray" } });
    expect(result.total).toBe(3);
    expect(result.count).toBe("3 assignments");
    expect(result.byRole).toEqual({ Owner: 1, Reader: 1, Contributor: 1 });
    const rows = result.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ principal: "Analyst", type: "User", role: "Owner" });
    expect(rows[0]?.["scope"]).toBe("Sandbox");
  });

  it("filters to privileged roles by GUID", async () => {
    const result = await run(["list", "--privileged"]);
    expect(result.total).toBe(2);
    expect(result.byRole).toEqual({ Owner: 1, Contributor: 1 });
  });

  it("filters by principal object ID, role name and scope", async () => {
    expect((await run(["list", "--principal", P2])).total).toBe(1);
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: "graph", method: "GET" }),
    );

    expect((await run(["list", "--role", "owner"])).total).toBe(1);
    expect((await run(["list", "--role", "READER"])).total).toBe(1);

    expect((await run(["list", "--scope", `/subscriptions/${SUB_A}`])).total).toBe(2);
    expect((await run(["list", "--scope", `/subscriptions/${SUB_A}/resourceGroups/rg-demo`])).total).toBe(2);
    expect((await run(["list", "--scope", `/subscriptions/${SUB_B}`])).total).toBe(1);
  });

  it("resolves a UPN through Graph and asks for the object ID when Graph fails", async () => {
    const result = await run(["list", "--principal", "analyst@contoso.com"]);
    expect(result.total).toBe(2);
    expect(sendMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: "graph", method: "GET" }),
    );

    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      if (options["resource"] === "graph") {
        throw new AxiError("denied", "FORBIDDEN", ["no"]);
      }
      return { status: 200, headers: {}, body: { data: [] }, clientRequestId: "r" } as never;
    });
    await expect(run(["list", "--principal", "other@contoso.com"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("still succeeds with IDs when Graph returns 403", async () => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      if (options["resource"] === "graph") {
        throw new AxiError("access denied", "FORBIDDEN", ["graph"]);
      }
      return { status: 200, headers: {}, body: { totalRecords: 1, count: 1, data: [row()] }, clientRequestId: "r" } as never;
    });
    const result = await run(["list"]);
    expect(result.total).toBe(1);
    expect((result.rows as Array<Record<string, unknown>>)[0]?.["principal"]).toBe(P1);
    expect((result.help as string[]).join("\n")).toMatch(/could not be resolved/i);
  });

  it("returns an explicit empty state", async () => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      if (options["resource"] === "graph") {
        return { status: 200, headers: {}, body: { value: [] }, clientRequestId: "g" } as never;
      }
      return { status: 200, headers: {}, body: { totalRecords: 0, count: 0, data: [] }, clientRequestId: "r" } as never;
    });
    const result = await run(["list", "--privileged"]);
    expect(result.rows).toMatch(/^0 role assignments found/);
    expect((result.help as string[]).join("\n")).toContain("az-axi sub list");
  });

  it("picks fields and shows full IDs with --full", async () => {
    const picked = (await run(["list", "--fields", "principal,role"])).rows as Array<Record<string, unknown>>;
    expect(picked[0]).toEqual({ principal: "Analyst", role: "Owner" });

    const full = (await run(["list", "--full"])).rows as Array<Record<string, unknown>>;
    expect(full[0]?.["scope"]).toBe(`/subscriptions/${SUB_A}`);
  });

  it("prints the query with --show-query without network", async () => {
    sendMock.mockClear();
    const result = await run(["list", "--show-query"]);
    expect(result.query).toBe(RBAC_ASSIGNMENTS);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("prefers flags, then profile management group, then profile subscriptions", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ profiles: { work: { auth: "az", managementGroup: "mg-profile", subscriptions: [SUB_B] } } }),
    );
    await run(["list", "--subscription", SUB_A, "--profile", "work"]);
    expect(armBody()).toMatchObject({ subscriptions: [SUB_A] });

    sendMock.mockClear();
    mockGraphNames();
    await run(["list", "--profile", "work"]);
    expect(armBody()).toMatchObject({ managementGroups: ["mg-profile"] });
  });

  it("rejects bad usage", async () => {
    await expect(run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["get"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "--limit", "0"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "--limit", "1001"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "--top", "5"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
  });
});
