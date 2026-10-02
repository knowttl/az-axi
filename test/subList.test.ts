import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ requestAll: vi.fn() }));

import { run } from "../src/commands/sub.js";
import { requestAll } from "../src/lib/client.js";

const requestAllMock = vi.mocked(requestAll);
const ID = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;

// source: resources/resource-manager/Microsoft.Resources/subscriptions/stable/2022-12-01/examples/GetSubscriptions.json (identifiers replaced)
const sub = (n: number, displayName: string, state = "Enabled") => ({
  id: `/subscriptions/${ID(n)}`,
  subscriptionId: ID(n),
  displayName,
  state,
});

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-sub-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  requestAllMock.mockReset();
  requestAllMock.mockResolvedValue({ items: [sub(22, "Zeta"), sub(21, "Alpha"), sub(23, "Mid", "Disabled")] });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("sub list", () => {
  it("lists subscriptions sorted by name with a count line", async () => {
    const result = await run(["list"]);
    expect(requestAllMock).toHaveBeenCalledWith(expect.objectContaining({ name: "az" }), {
      path: "/subscriptions",
      apiVersion: "2022-12-01",
    });
    expect(result.count).toBe("3 subscriptions");
    expect(result.subscriptions).toEqual([
      { name: "Alpha", id: ID(21), state: "Enabled", inScope: "yes" },
      { name: "Mid", id: ID(23), state: "Disabled", inScope: "yes" },
      { name: "Zeta", id: ID(22), state: "Enabled", inScope: "yes" },
    ]);
  });

  it("marks the subscriptions in the active profile's scope", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ profiles: { work: { auth: "az", subscriptions: [ID(22).toUpperCase()] } } }),
    );
    const rows = (await run(["list"])).subscriptions as Array<{ name: string; inScope: string }>;
    expect(rows.map((row) => [row.name, row.inScope])).toEqual([["Alpha", "no"], ["Mid", "no"], ["Zeta", "yes"]]);
  });

  it("honours --subscription as the scope for the marker", async () => {
    const rows = (await run(["list", "--subscription", ID(21)])).subscriptions as Array<{ name: string; inScope: string }>;
    expect(rows.map((row) => row.inScope)).toEqual(["yes", "no", "no"]);
  });

  it("caps rows with --limit and offers --full", async () => {
    const result = await run(["list", "--limit", "2"]);
    expect(result.count).toBe("2 of 3 subscriptions");
    expect(result.subscriptions).toHaveLength(2);
    expect(result.help).toContain("Run `az-axi sub list --full` to list every subscription");
    expect((await run(["list", "--limit", "2", "--full"])).subscriptions).toHaveLength(3);
  });

  it("picks fields with --fields", async () => {
    const result = await run(["list", "--fields", "name,state"]);
    expect((result.subscriptions as unknown[])[0]).toEqual({ name: "Alpha", state: "Enabled" });
  });

  it("returns an explicit empty state with a hint", async () => {
    requestAllMock.mockResolvedValue({ items: [] });
    const result = await run(["list"]);
    expect(result.subscriptions).toBe("0 subscriptions found visible to this identity");
    expect(String((result.help as string[])[0])).toContain("az login");
  });

  it("says when paging stopped early", async () => {
    requestAllMock.mockResolvedValue({ items: [sub(21, "Alpha")], nextLink: "https://management.azure.com/next" });
    const result = await run(["list"]);
    expect(result.count).toBe("1 subscriptions");
    expect(String((result.help as string[]).join("\n"))).toContain("page cap");
  });

  it("rejects bad usage", async () => {
    await expect(run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["get"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "--top", "3"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(run(["list", "--limit", "0"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "--limit", "abc"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
