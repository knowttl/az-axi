import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/auth.js", () => ({ identityOf: vi.fn() }));
vi.mock("../src/lib/client.js", () => ({ requestAll: vi.fn(), sendRequest: vi.fn() }));

import { run } from "../src/commands/home.js";
import { identityOf } from "../src/lib/auth.js";
import { requestAll, sendRequest } from "../src/lib/client.js";
import { resolveWriteLogPath } from "../src/lib/writeLog.js";
import { collapseHomeDirectory } from "../src/lib/paths.js";

const identityMock = vi.mocked(identityOf);
const allMock = vi.mocked(requestAll);
const sendMock = vi.mocked(sendRequest);

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_TENANT", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_READ_ONLY", "AZ_AXI_WRITE_LOG"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-home-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  vi.resetAllMocks();
  identityMock.mockResolvedValue({ name: "ada@contoso.com", type: "user", tenantId: "00000000-0000-0000-0000-000000000001" });
  allMock.mockResolvedValue({ items: [{}, {}] });
  sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
    const query = String((options["body"] as { query?: string })?.query ?? "");
    if (query.includes("securescores")) {
      return {
        status: 200,
        headers: {},
        body: { totalRecords: 1, data: [{ subscriptionId: "00000000-0000-0000-0000-000000000001", current: 80, max: 100, percent: 80 }] },
        clientRequestId: "r",
      } as never;
    }
    return { status: 200, headers: {}, body: { totalRecords: 0, data: [] }, clientRequestId: "r" } as never;
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("dashboard skeleton", () => {
  it("shows the profile and identity section", async () => {
    const result = await run([]);
    expect(result).toMatchObject({
      profile: "az",
      identity: "ada@contoso.com",
      type: "user",
      subscriptions: 2,
      writes: "disabled (default)",
      writeSubscriptions: [],
      readOnly: { set: false, forced: false },
      writeLog: collapseHomeDirectory(resolveWriteLogPath()),
    });
    expect(allMock).toHaveBeenCalledWith(expect.anything(), { path: "/subscriptions", apiVersion: "2022-12-01" }, 100);
    expect((result.help as string[]).join("\n")).toContain("az-axi sub list");
  });

  it("reports configured write scope, environment override and log without write-enablement hints", async () => {
    const sub = "00000000-0000-0000-0000-000000000020";
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { sandbox: { auth: "token", allowWrites: true, subscriptions: [sub] } } }));
    process.env.AZ_AXI_WRITE_LOG = join(dir, "custom.log");
    process.env.AZ_AXI_SUBSCRIPTION = "00000000-0000-0000-0000-000000000021";
    const result = await run(["--subscription", "00000000-0000-0000-0000-000000000022"]);
    expect(result).toMatchObject({ writes: "ENABLED for 1 subscription", writeSubscriptions: [sub], readOnly: { set: false, forced: false }, writeLog: join(dir, "custom.log") });
    process.env.AZ_AXI_READ_ONLY = "true";
    expect(await run([])).toMatchObject({ writes: "disabled (AZ_AXI_READ_ONLY)", writeSubscriptions: [sub], readOnly: { set: true, forced: true } });
    process.env.AZ_AXI_READ_ONLY = "";
    expect(await run([])).toMatchObject({ readOnly: { set: true, forced: false } });
    expect(JSON.stringify(result.help)).not.toMatch(/allowWrites/);
  });

  it("reports token identities without calling az", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token" } } }));
    const result = await run([]);
    expect(result).toMatchObject({ profile: "ci", identity: "(token)", type: "token" });
    expect(identityMock).not.toHaveBeenCalled();
  });

  it("shows alert counts, secure score and exposure sections", async () => {
    const result = await run([]);
    expect(result.defender).toBe("0 active alerts");
    expect(result.score).toEqual({
      average: "80.0%",
      lowest: "00000000-0000-0000-0000-000000000001",
      lowestPercent: "80.0%",
    });
    expect(result.exposure).toEqual({ publicIps: 0, mgmtPorts: 0, anyAny: 0 });
    expect((result.help as string[]).join("\n")).toContain("defender assessments --severity High");
  });

  it("keeps a successful section when another call fails", async () => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      const query = String((options["body"] as { query?: string })?.query ?? "");
      if (query.includes("locations/alerts")) throw new Error("denied");
      if (query.includes("securescores")) {
        return {
          status: 200,
          headers: {},
          body: { totalRecords: 1, data: [{ subscriptionId: "00000000-0000-0000-0000-000000000001", current: 80, max: 100, percent: 80 }] },
          clientRequestId: "r",
        } as never;
      }
      return { status: 200, headers: {}, body: { totalRecords: 2, data: [] }, clientRequestId: "r" } as never;
    });
    const result = await run([]);
    expect(result.defender).toBe("-");
    expect(result.score).toEqual({
      average: "80.0%",
      lowest: "00000000-0000-0000-0000-000000000001",
      lowestPercent: "80.0%",
    });
    expect(result.exposure).toEqual({ publicIps: 2, mgmtPorts: 2, anyAny: 2 });
    expect((result.help as string[]).join("\n")).toContain("[defender]");
  });

  it("degrades a section with a hint instead of failing", async () => {
    identityMock.mockRejectedValue(new AxiError("not signed in", "AUTH_REQUIRED", ["Run `az login`"]));
    allMock.mockRejectedValue(new AxiError("boom", "API_ERROR", ["requestId: r1"]));
    sendMock.mockRejectedValue(new AxiError("boom", "API_ERROR", ["requestId: r1"]));
    const result = await run([]);
    expect(result.identity).toBe("-");
    expect(result.subscriptions).toBe("-");
    expect(result.defender).toBe("-");
    expect(result.score).toBe("-");
    expect(result.exposure).toBe("-");
    const help = (result.help as string[]).join("\n");
    expect(help).toContain("[identity]");
    expect(help).toContain("[subscriptions]");
    expect(help).toContain("[defender]");
    expect(help).toContain("[exposure]");
    expect(help).toContain("az-axi doctor");
  });

  it("marks truncated subscription counts", async () => {
    allMock.mockResolvedValue({ items: [{}], nextLink: "https://management.azure.com/next" });
    expect((await run([])).subscriptions).toBe("1+");
  });

  it("shows config, profiles and the error without a working profile", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { a: { auth: "az" }, b: { auth: "az" } } }));
    const result = await run([]);
    expect(result.error).toContain("several profiles");
    expect(result.profiles).toEqual(["a", "b"]);
    expect((result.help as string[]).join("\n")).toContain("az-axi doctor");
  });

  it("rejects stray arguments and unknown flags", async () => {
    await expect(run(["extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["--org", "x"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
  });
});
