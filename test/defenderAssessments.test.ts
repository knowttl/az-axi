import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), requestAll: vi.fn() }));

import { run } from "../src/commands/defender.js";
import { requestAll, sendRequest } from "../src/lib/client.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import { DEFENDER_ASSESSMENTS, DEFENDER_SECURE_SCORES, defenderAssessmentsQuery } from "../src/lib/queries.js";

const sendMock = vi.mocked(sendRequest);
const allMock = vi.mocked(requestAll);

const SYN = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const SUB_A = SYN(20);
const SUB_B = SYN(21);

// source: Defender Resource Graph samples (identifiers replaced)
const assessment = (overrides: Record<string, unknown> = {}) => ({
  recommendation: "MFA should be enabled",
  severity: "High",
  status: "Unhealthy",
  resourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm1`,
  subscriptionId: SUB_A,
  id: `/subscriptions/${SUB_A}/providers/Microsoft.Security/assessments/${SYN(50)}`,
  ...overrides,
});

const score = (overrides: Record<string, unknown> = {}) => ({
  subscriptionId: SUB_A,
  current: 42.5,
  max: 100,
  // The query scales `score.percentage` to 0-100 before the command sees it.
  percent: 42.5,
  id: `/subscriptions/${SUB_A}/providers/Microsoft.Security/secureScores/ascScore`,
  ...overrides,
});

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

function mockGraph(assessments: Array<Record<string, unknown>>, scores: Array<Record<string, unknown>>) {
  sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
    const body = options["body"] as { query?: string };
    const query = String(body?.query ?? "");
    if (query.includes("microsoft.security/securescores")) {
      return { status: 200, headers: {}, body: { totalRecords: scores.length, data: scores }, clientRequestId: "r" } as never;
    }
    return {
      status: 200,
      headers: {},
      body: { totalRecords: assessments.length, data: assessments },
      clientRequestId: "r",
    } as never;
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-defassess-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  clearSubscriptionCache();
  sendMock.mockReset();
  allMock.mockReset();
  allMock.mockResolvedValue({ items: [{ subscriptionId: SUB_A, displayName: "Sandbox" }] });
  mockGraph(
    [
      assessment(),
      assessment({ resourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm2` }),
      assessment({
        recommendation: "Auditing should be enabled",
        severity: "Medium",
        status: "Healthy",
        resourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Storage/storageAccounts/st1`,
      }),
      assessment({
        recommendation: "Auditing should be enabled",
        severity: "Medium",
        status: "Unhealthy",
        resourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Storage/storageAccounts/st2`,
      }),
    ],
    [score()],
  );
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
  const call = sendMock.mock.calls.find(([, options]) =>
    String(((options as Record<string, unknown>)["body"] as { query?: string })?.query ?? "").includes(
      "microsoft.security/assessments",
    ),
  );
  return ((call?.[1] as { body: Record<string, unknown> }).body ?? {}) as { query: string };
}

describe("defender assessments", () => {
  it("posts the canned query and groups one row per recommendation", async () => {
    const result = await run(["assessments"]);
    const [, options] = sendMock.mock.calls.find(([, o]) =>
      String(((o as Record<string, unknown>)["body"] as { query?: string })?.query ?? "").includes("assessments"),
    ) as unknown as [unknown, { path: string; apiVersion: string; method: string }];
    expect(options.path).toBe("/providers/Microsoft.ResourceGraph/resources");
    expect(options.apiVersion).toBe("2024-04-01");
    expect(armBody().query).toBe(DEFENDER_ASSESSMENTS);
    expect(result.total).toBe(2);
    expect(result.count).toBe("2 recommendations");
    expect(result.unhealthy).toBe(3);
    expect(result.bySeverity).toEqual({ High: 2, Medium: 1 });
    const rows = result.rows as Array<Record<string, unknown>>;
    // Worst severity first, then unhealthy count.
    expect(rows[0]).toEqual({ recommendation: "MFA should be enabled", severity: "High", unhealthyCount: 2, total: 2 });
    expect(rows[1]).toEqual({ recommendation: "Auditing should be enabled", severity: "Medium", unhealthyCount: 1, total: 2 });
    expect(String(armBody().query)).toContain("properties.resourceDetails.id");
  });

  it("narrows the KQL and the rows with severity and status", async () => {
    const result = await run(["assessments", "--severity", "High", "--status", "Unhealthy"]);
    expect(String(armBody().query)).toContain("severity =~ 'High'");
    expect(String(armBody().query)).toContain("status =~ 'Unhealthy'");
    expect(result.total).toBe(1);
    expect((result.rows as Array<Record<string, unknown>>)[0]?.["recommendation"]).toBe("MFA should be enabled");
  });

  it("switches to per-resource rows with --resource", async () => {
    const result = await run(["assessments", "--resource", "vm1"]);
    expect(result.total).toBe(1);
    const rows = result.rows as Array<Record<string, unknown>>;
    expect(String(rows[0]?.["resource"])).toContain("vm1");
    expect(rows[0]).toMatchObject({ severity: "High", status: "Unhealthy" });

    const empty = await run(["assessments", "--resource", "no-such-vm"]);
    expect(empty.total).toBe(0);
    expect(empty.rows).toMatch(/^0 assessment results found/);

    const recommendation = await run(["assessments", "--resource", "enabled"]);
    expect(recommendation.total).toBe(0);
  });

  it("prints the query with --show-query without network", async () => {
    sendMock.mockClear();
    const result = await run(["assessments", "--show-query"]);
    expect(result.query).toBe(DEFENDER_ASSESSMENTS);
    expect(sendMock).not.toHaveBeenCalled();

    const filtered = await run(["assessments", "--show-query", "--severity", "High"]);
    expect(String(filtered.query)).toContain("severity =~ 'High'");
  });

  it("returns an explicit empty state", async () => {
    mockGraph([], []);
    const result = await run(["assessments"]);
    expect(result.rows).toMatch(/^0 Defender recommendations found/);
    expect((result.help as string[]).join("\n")).toContain("az-axi sub list");
  });

  it("rejects newlines in filter values", () => {
    expect(() => defenderAssessmentsQuery({ severity: "High\nLow" })).toThrowError();
  });
});

describe("defender score", () => {
  it("returns one row per subscription sorted by percent ascending", async () => {
    mockGraph([], [
      score(),
      score({ subscriptionId: SUB_B, current: 90, max: 100, percent: 90 }),
      // No scaled percent: recomputed from current/max.
      score({ subscriptionId: SYN(22), current: 10, max: 20, percent: undefined }),
    ]);
    const result = await run(["score"]);
    const [, options] = sendMock.mock.calls.find(([, o]) =>
      String(((o as Record<string, unknown>)["body"] as { query?: string })?.query ?? "").includes("securescores"),
    ) as unknown as [unknown, { path: string; apiVersion: string }];
    expect(options.apiVersion).toBe("2024-04-01");
    expect(String(((options as unknown as { body: { query: string } }).body.query))).toBe(DEFENDER_SECURE_SCORES);
    expect(DEFENDER_SECURE_SCORES).toContain('name =~ "ascScore"');
    expect(result.total).toBe(3);
    const rows = result.rows as Array<Record<string, unknown>>;
    expect(rows.map((row) => row["percent"])).toEqual([42.5, 50, 90]);
    expect(rows[0]).toMatchObject({ current: 42.5, max: 100 });
    expect((result.help as string[]).join("\n")).toContain("defender assessments --severity High");
  });

  it("returns an explicit empty state", async () => {
    mockGraph([], []);
    const result = await run(["score"]);
    expect(result.rows).toMatch(/^0 secure scores found/);
  });

  it("rejects bad usage", async () => {
    await expect(run(["score", "extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["score", "--limit", "1001"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["score", "--severity", "High"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
  });
});
