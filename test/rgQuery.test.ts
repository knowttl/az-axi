import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), requestAll: vi.fn() }));
vi.mock("../src/lib/stdin.js", () => ({ readStdinIfPiped: vi.fn() }));

import { run } from "../src/commands/rg.js";
import { requestAll, sendRequest } from "../src/lib/client.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import { readStdinIfPiped } from "../src/lib/stdin.js";

const sendMock = vi.mocked(sendRequest);
const allMock = vi.mocked(requestAll);
const stdinMock = vi.mocked(readStdinIfPiped);

const SUB_A = "00000000-0000-0000-0000-000000000020";
const SUB_B = "00000000-0000-0000-0000-000000000021";
const VM_ID = `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm1`;

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

const headers = (extra: Record<string, string> = {}) => extra;

function graphBody(overrides: Record<string, unknown> = {}) {
  return {
    totalRecords: 2,
    count: 2,
    data: [
      { name: "vm1", type: "microsoft.compute/virtualmachines", id: VM_ID },
      { name: "st1", type: "microsoft.storage/storageaccounts", resourceGroup: "rg-demo" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-rg-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  clearSubscriptionCache();
  sendMock.mockReset();
  allMock.mockReset();
  stdinMock.mockReset();
  stdinMock.mockResolvedValue(undefined);
  sendMock.mockResolvedValue({ status: 200, headers: headers(), body: graphBody(), clientRequestId: "req-1" });
  allMock.mockResolvedValue({ items: [{ subscriptionId: SUB_A, displayName: "Sandbox" }] });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

function lastBody() {
  const calls = sendMock.mock.calls;
  return calls[calls.length - 1]?.[1].body as Record<string, unknown>;
}

describe("rg query", () => {
  it("posts the query unchanged with scope precedence and formats rows", async () => {
    const result = await run(["query", "Resources | take 5"]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [, options] = sendMock.mock.calls[0] as unknown as [unknown, { path: string; apiVersion: string; body: unknown; method: string }];
    expect(options.path).toBe("/providers/Microsoft.ResourceGraph/resources");
    expect(options.apiVersion).toBe("2024-04-01");
    expect(options.method).toBe("POST");
    expect(lastBody()).toMatchObject({
      query: "Resources | take 5",
      options: { $top: 50, resultFormat: "objectArray" },
    });
    expect(result.total).toBe(2);
    expect(result.count).toBe("2 resources");
    const rows = result.rows as Array<Record<string, unknown>>;
    expect(rows[0]?.["id"]).toBe(`Sandbox/rg-demo/vm/vm1`);
    expect(result.help).toBeUndefined();
  });

  it("prefers flags, then profile management group, then profile subscriptions", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        profiles: {
          work: { auth: "az", managementGroup: "mg-profile", subscriptions: [SUB_B] },
        },
      }),
    );
    await run(["query", "Resources | take 1", "--subscription", SUB_A]);
    expect(lastBody()).toMatchObject({ subscriptions: [SUB_A] });

    await run(["query", "Resources | take 1", "--subscription", SUB_A, "--management-group", "mg-flag"]);
    expect(lastBody()).toMatchObject({ managementGroups: ["mg-flag"] });

    sendMock.mockClear();
    await run(["query", "Resources | take 1", "--profile", "work"]);
    expect(lastBody()).toMatchObject({ managementGroups: ["mg-profile"] });

    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { s: { auth: "az", subscriptions: [SUB_B] } } }));
    sendMock.mockClear();
    await run(["query", "Resources | take 1", "--profile", "s"]);
    expect(lastBody()).toMatchObject({ subscriptions: [SUB_B] });
  });

  it("returns a skip-token help entry with the exact next command", async () => {
    sendMock.mockResolvedValue({
      status: 200,
      headers: headers(),
      body: graphBody({ $skipToken: "tok-123" }),
      clientRequestId: "req-1",
    });
    const result = await run(["query", "Resources | take 1", "--limit", "1", "--subscription", SUB_A]);
    const help = result.help as string[];
    expect(help).toHaveLength(1);
    expect(help[0]).toContain("--skip-token tok-123");
    expect(help[0]).toContain("--subscription");
    expect(help[0]).toContain("--limit 1");
    expect(help[0]).toContain("Resources | take 1");
  });

  it("returns an explicit empty state", async () => {
    sendMock.mockResolvedValue({
      status: 200,
      headers: headers(),
      body: { totalRecords: 0, count: 0, data: [] },
      clientRequestId: "req-1",
    });
    const result = await run(["query", "Resources | where false"]);
    expect(result.count).toBe("0 resources");
    expect(result.rows).toMatch(/^0 resources found/);
    expect((result.help as string[]).join("\n")).toContain("az-axi sub list");
  });

  it("truncates nested objects at 200 chars unless --full", async () => {
    const big = { a: "x".repeat(500), nested: { deep: "y".repeat(500) } };
    sendMock.mockResolvedValue({
      status: 200,
      headers: headers(),
      body: { totalRecords: 1, count: 1, data: [{ name: "r", props: big, note: "z".repeat(500) }] },
      clientRequestId: "req-1",
    });
    const truncated = (await run(["query", "Resources | take 1"])).rows as Array<Record<string, unknown>>;
    expect(String(truncated[0]?.["props"]).length).toBeLessThan(300);
    expect(String(truncated[0]?.["props"])).toContain("truncated");
    expect(String(truncated[0]?.["note"]).length).toBeLessThan(300);

    const full = (await run(["query", "Resources | take 1", "--full"])).rows as Array<Record<string, unknown>>;
    expect(String(full[0]?.["note"]).length).toBe(500);
    expect(sendMock.mock.calls.at(-1)?.[1].body).toMatchObject({ options: { $top: 1000 } });
  });

  it("picks fields with --fields and shows the full id on request", async () => {
    const result = await run(["query", "Resources | take 5", "--fields", "name"]);
    expect((result.rows as Array<unknown>)[0]).toEqual({ name: "vm1" });

    const withId = (await run(["query", "Resources | take 5", "--fields", "id"])).rows as Array<Record<string, unknown>>;
    expect(withId[0]?.["id"]).toBe(VM_ID);
  });

  it("reads multi-line KQL from --file and stdin", async () => {
    const file = join(dir, "query.kql");
    writeFileSync(file, "Resources\n| take 5\n");
    await run(["query", "--file", file]);
    expect(lastBody()).toMatchObject({ query: "Resources\n| take 5" });

    stdinMock.mockResolvedValueOnce(Buffer.from("Resources | take 9\n"));
    await run(["query"]);
    expect(lastBody()).toMatchObject({ query: "Resources | take 9" });
  });

  it("surfaces Resource Graph throttling as RATE_LIMITED", async () => {
    sendMock.mockRejectedValue(new AxiError("rate limited by management.azure.com", "RATE_LIMITED", ["Retry after 5 seconds"]));
    await expect(run(["query", "Resources | take 1"])).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("hints when Resource Graph truncated the result without a skip token", async () => {
    sendMock.mockResolvedValue({
      status: 200,
      headers: headers(),
      body: graphBody({ resultTruncated: "true" }),
      clientRequestId: "req-1",
    });
    const result = await run(["query", "Resources | take 1"]);
    expect((result.help as string[]).join("\n")).toMatch(/truncated/i);
  });

  it("hints when the quota header is exhausted on success", async () => {
    sendMock.mockResolvedValue({
      status: 200,
      headers: headers({ "x-ms-user-quota-remaining": "0", "x-ms-user-quota-resets-after": "00:00:07" }),
      body: graphBody(),
      clientRequestId: "req-1",
    });
    const result = await run(["query", "Resources | take 1"]);
    expect((result.help as string[]).join("\n")).toContain("00:00:07");
  });

  it("rejects bad usage", async () => {
    await expect(run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["get"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["query"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["query", "q", "extra", "more"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["query", "q", "--limit", "0"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["query", "q", "--limit", "1001"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["query", "q", "--top", "5"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
  });
});
