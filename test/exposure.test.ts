import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), requestAll: vi.fn() }));

import { run } from "../src/commands/exposure.js";
import { requestAll, sendRequest } from "../src/lib/client.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import { EXPOSURE_ANY_ANY, EXPOSURE_MGMT_PORTS, EXPOSURE_PUBLIC_IPS } from "../src/lib/queries.js";

const sendMock = vi.mocked(sendRequest);
const allMock = vi.mocked(requestAll);

const SYN = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const SUB_A = SYN(20);

// source: Resource Graph starter samples, network shapes (identifiers replaced)
const ipRow = (n: number) => ({
  resource: `pip-${n}`,
  resourceGroup: "rg-demo",
  subscriptionId: SUB_A,
  detail: `10.0.0.${n} -> /subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/networkInterfaces/nic-${n}`,
  id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/publicIPAddresses/pip-${n}`,
});

const mgmtRow = (n: number) => ({
  resource: `nsg-${n}`,
  resourceGroup: "rg-demo",
  subscriptionId: SUB_A,
  detail: `rule ssh src * ports 22`,
  id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/networkSecurityGroups/nsg-${n}`,
});

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

function mockExposure(ips: Array<Record<string, unknown>>, ports: Array<Record<string, unknown>>, any: Array<Record<string, unknown>>) {
  sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
    const query = String((options["body"] as { query?: string })?.query ?? "");
    const data = query === EXPOSURE_PUBLIC_IPS ? ips : query === EXPOSURE_MGMT_PORTS ? ports : any;
    return {
      status: 200,
      headers: {},
      body: { totalRecords: data.length, data },
      clientRequestId: "r",
    } as never;
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-exposure-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  clearSubscriptionCache();
  sendMock.mockReset();
  allMock.mockReset();
  allMock.mockResolvedValue({ items: [{ subscriptionId: SUB_A, displayName: "Sandbox" }] });
  mockExposure([ipRow(1)], [mgmtRow(1)], []);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
  clearSubscriptionCache();
});

function sentQuery() {
  return String((sendMock.mock.calls[0]?.[1] as { body: { query: string } })?.body?.query ?? "");
}

describe("exposure", () => {
  it("runs one canned query and formats rows", async () => {
    const result = await run(["--check", "public-ips"]);
    expect(sentQuery()).toBe(EXPOSURE_PUBLIC_IPS);
    expect(result.check).toBe("public-ips");
    expect(result.total).toBe(1);
    expect(result.count).toBe("1 public IP addresses");
    const rows = result.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      resource: "pip-1",
      resourceGroup: "rg-demo",
      subscription: "Sandbox",
      detail: expect.stringContaining("10.0.0.1"),
    });
  });

  it("returns per-check counts plus the first 10 rows each for --check all", async () => {
    mockExposure(
      Array.from({ length: 12 }, (_, i) => ipRow(i + 1)),
      [mgmtRow(1)],
      [],
    );
    const result = await run([]);
    expect(sendMock).toHaveBeenCalledTimes(3); // one Resource Graph call per check
    expect(result.total).toBe(13);
    const checks = result.checks as Record<string, { total: number; count: string; rows: unknown[] }>;
    expect(checks["public-ips"]?.total).toBe(12);
    expect(checks["public-ips"]?.rows).toHaveLength(10);
    expect(checks["mgmt-ports"]?.total).toBe(1);
    expect(checks["any-any"]?.total).toBe(0);
    expect((result.help as string[]).join("\n")).toContain("az-axi exposure --check mgmt-ports");
    expect(checks["any-any"]?.rows).toMatch(/^0 any-any NSG rules found/);
  });

  it("honors --limit as the per-check cap for --check all", async () => {
    mockExposure(
      Array.from({ length: 4 }, (_, i) => ipRow(i + 1)),
      [],
      [],
    );
    const result = await run(["--limit", "2"]);
    const checks = result.checks as Record<string, { rows: unknown[] }>;
    expect(checks["public-ips"]?.rows).toHaveLength(2);
  });

  it("uses exact port matches and attached public IPs only", () => {
    expect(EXPOSURE_PUBLIC_IPS).toContain("isnotempty(ipConfig)");
    expect(EXPOSURE_PUBLIC_IPS).not.toContain("unattached");
    expect(EXPOSURE_MGMT_PORTS).not.toContain('contains "22"');
    expect(EXPOSURE_MGMT_PORTS).toContain("has_any");
    expect(EXPOSURE_ANY_ANY).toContain("sourceAddressPrefixes");
  });

  it("lets $AZ_AXI_SUBSCRIPTION override a profile management group", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        profiles: {
          work: {
            auth: "az",
            managementGroup: "contoso-root",
            subscriptions: ["00000000-0000-0000-0000-000000000099"],
          },
        },
      }),
    );
    process.env.AZ_AXI_PROFILE = "work";
    process.env.AZ_AXI_SUBSCRIPTION = SUB_A;
    await run(["--check", "public-ips"]);
    const body = (sendMock.mock.calls[0]?.[1] as { body: { subscriptions?: string[]; managementGroups?: string[] } }).body;
    expect(body.subscriptions).toEqual([SUB_A]);
    expect(body.managementGroups).toBeUndefined();
  });

  it("degrades one failed check with a hint instead of failing", async () => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      const query = String((options["body"] as { query?: string })?.query ?? "");
      if (query === EXPOSURE_ANY_ANY) throw new Error("throttled");
      if (query === EXPOSURE_PUBLIC_IPS) {
        return { status: 200, headers: {}, body: { totalRecords: 1, data: [ipRow(1)] }, clientRequestId: "r" } as never;
      }
      return { status: 200, headers: {}, body: { totalRecords: 0, data: [] }, clientRequestId: "r" } as never;
    });
    const result = await run([]);
    const checks = result.checks as Record<string, unknown>;
    expect((checks["any-any"] as { total: unknown }).total).toBe("-");
    expect((result.help as string[]).join("\n")).toContain("[any-any]");
  });

  it("prints canned queries with --show-query without network", async () => {
    sendMock.mockClear();
    const one = await run(["--show-query", "--check", "mgmt-ports"]);
    expect(one.checks).toEqual({ "mgmt-ports": EXPOSURE_MGMT_PORTS });
    expect(sendMock).not.toHaveBeenCalled();

    const all = await run(["--show-query"]) as { checks: Record<string, string> };
    expect(Object.keys(all.checks)).toEqual(["public-ips", "mgmt-ports", "any-any"]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns an explicit empty state for one check", async () => {
    mockExposure([], [], []);
    const result = await run(["--check", "any-any"]);
    expect(result.rows).toMatch(/^0 any-any NSG rules found/);
    expect((result.help as string[]).join("\n")).toContain("--check all");
  });

  it("rejects bad usage", async () => {
    await expect(run(["extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["--check", "buckets"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["--check", "all", "--limit", "0"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["--top", "5"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
  });
});
