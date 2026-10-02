import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn() }));

import { run } from "../src/commands/api.js";
import { sendRequest } from "../src/lib/client.js";

const sendMock = vi.mocked(sendRequest);

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

const ok = (body: unknown, extra: Record<string, unknown> = {}) => ({
  status: 200,
  headers: {},
  body,
  clientRequestId: "req-1",
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-api-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  sendMock.mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("api escape hatch", () => {
  it("gets a list path with an explicit method and api-version", async () => {
    sendMock.mockResolvedValue(ok({ value: [{ name: "a" }, { name: "b" }] }));
    const result = await run(["GET", "/subscriptions", "--api-version", "2022-12-01"]);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "az" }),
      expect.objectContaining({ method: "GET", resource: "arm", path: "/subscriptions", apiVersion: "2022-12-01" }),
    );
    expect(result.status).toBe(200);
    expect(result.count).toBe("2 items");
    expect(result.value).toHaveLength(2);
  });

  it("defaults to GET when only a path is given", async () => {
    sendMock.mockResolvedValue(ok({ value: [] }));
    await run(["/subscriptions", "--api-version", "2022-12-01"]);
    expect(sendMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", path: "/subscriptions" });
  });

  it("passes resource, query string and parsed body through", async () => {
    sendMock.mockResolvedValue(ok({ totalRecords: 1, data: [] }));
    await run([
      "POST",
      "/providers/Microsoft.ResourceGraph/resources",
      "--api-version",
      "2024-04-01",
      "--query",
      "k=v&k2=v2",
      "--body",
      '{"query":"Resources | take 1"}',
    ]);
    expect(sendMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      resource: "arm",
      query: { k: "v", k2: "v2" },
      body: { query: "Resources | take 1" },
    });
  });

  it("returns single objects with their status", async () => {
    sendMock.mockResolvedValue(ok({ name: "rg1", location: "westus" }));
    const result = await run(["/resourceGroups/rg1", "--api-version", "2021-04-01"]);
    expect(result.status).toBe(200);
    expect(result).toMatchObject({ name: "rg1", location: "westus" });
  });

  it("truncates long strings at 4,000 chars unless --full", async () => {
    sendMock.mockResolvedValue(ok({ value: [{ name: "x".repeat(5000) }] }));
    const truncated = (await run(["/things", "--api-version", "1"])).value as Array<{ name: string }>;
    expect(truncated[0]?.name.length).toBeLessThan(5000);
    expect(truncated[0]?.name).toContain("truncated");

    sendMock.mockResolvedValue(ok({ value: [{ name: "x".repeat(5000) }] }));
    const full = (await run(["/things", "--api-version", "1", "--full"])).value as Array<{ name: string }>;
    expect(full[0]?.name.length).toBe(5000);
  });

  it("caps rows with --limit and picks --fields", async () => {
    sendMock.mockResolvedValue(ok({ value: [{ a: 1, b: 2 }, { a: 3, b: 4 }] }));
    const limited = await run(["/things", "--api-version", "1", "--limit", "1"]);
    expect((limited.value as unknown[])).toHaveLength(1);

    sendMock.mockResolvedValue(ok({ value: [{ a: 1, b: 2 }] }));
    const picked = await run(["/things", "--api-version", "1", "--fields", "a"]);
    expect(picked.value).toEqual([{ a: 1 }]);
  });

  it("follows nextLink only with --all, capped at 10 pages", async () => {
    sendMock.mockReset();
    sendMock
      .mockResolvedValueOnce(ok({ value: [1], nextLink: "https://management.azure.com/next1?api-version=1" }))
      .mockResolvedValueOnce(ok({ value: [2] }));
    const withoutAll = await run(["/things", "--api-version", "1"]);
    expect(withoutAll.count).toBe("1+ items");
    expect((withoutAll.help as string[]).join(" ")).toContain("--all");
    expect((withoutAll.help as string[]).join(" ")).toContain("--api-version 1");

    sendMock.mockReset();
    sendMock
      .mockResolvedValueOnce(ok({ value: [1], nextLink: "https://management.azure.com/next1?api-version=1" }))
      .mockResolvedValueOnce(ok({ value: [2] }));
    const withAll = await run(["/things", "--api-version", "1", "--all"]);
    expect(withAll.count).toBe("2 items");
    expect(withAll.value).toEqual([1, 2]);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("follows nextLink with GET even when the first request was POST", async () => {
    sendMock
      .mockResolvedValueOnce(ok({ value: [1], nextLink: "https://management.azure.com/next1?api-version=1" }))
      .mockResolvedValueOnce(ok({ value: [2] }));
    const result = await run(["POST", "/things", "--api-version", "1", "--all"]);
    expect(result.value).toEqual([1, 2]);
    expect(sendMock.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      path: "https://management.azure.com/next1?api-version=1",
    });
  });

  it("preserves --resource in the next-page help and omits a fake api-version", async () => {
    sendMock.mockResolvedValue(ok({ value: [{ id: "1" }], nextLink: "https://graph.microsoft.com/v1.0/next" }));
    const result = await run(["/v1.0/users", "--resource", "graph"]);
    const help = (result.help as string[]).join(" ");
    expect(help).toContain("--resource graph");
    expect(help).toContain("--all");
    expect(help).not.toContain("api-version");
  });

  it("refuses writes through the Phase 1 gate stub and secrets as read-only", async () => {
    sendMock.mockRejectedValue(
      new AxiError("blocked: writes are disabled for profile 'az' (DELETE request)", "WRITES_DISABLED", [
        "Writes are disabled for this profile",
      ]),
    );
    await expect(run(["DELETE", "/x", "--api-version", "1"])).rejects.toMatchObject({ code: "WRITES_DISABLED" });

    sendMock.mockRejectedValue(
      new AxiError("blocked: POST listKeys returns credentials", "READ_ONLY", ["az-axi never calls actions that return keys"]),
    );
    await expect(run(["POST", "/x/listKeys", "--api-version", "1"])).rejects.toMatchObject({ code: "READ_ONLY" });
  });

  it("rejects bad usage", async () => {
    sendMock.mockResolvedValue(ok({}));
    await expect(run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["GET"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["/a", "/b"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["/x", "--resource", "vault"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["/x", "--api-version", "1", "--body", "not-json"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["/x", "--api-version", "1", "--limit", "0"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["/x", "--bogus", "1"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
  });
});
