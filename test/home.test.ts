import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/auth.js", () => ({ identityOf: vi.fn() }));
vi.mock("../src/lib/client.js", () => ({ requestAll: vi.fn() }));

import { run } from "../src/commands/home.js";
import { identityOf } from "../src/lib/auth.js";
import { requestAll } from "../src/lib/client.js";

const identityMock = vi.mocked(identityOf);
const allMock = vi.mocked(requestAll);

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_TENANT", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_READ_ONLY"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-home-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  vi.resetAllMocks();
  identityMock.mockResolvedValue({ name: "ada@contoso.com", type: "user", tenantId: "00000000-0000-0000-0000-000000000001" });
  allMock.mockResolvedValue({ items: [{}, {}] });
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
    });
    expect(allMock).toHaveBeenCalledWith(expect.anything(), { path: "/subscriptions", apiVersion: "2022-12-01" }, 100);
    expect((result.help as string[]).join("\n")).toContain("az-axi sub list");
  });

  it("reports token identities without calling az", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token" } } }));
    const result = await run([]);
    expect(result).toMatchObject({ profile: "ci", identity: "(token)", type: "token" });
    expect(identityMock).not.toHaveBeenCalled();
  });

  it("degrades a section with a hint instead of failing", async () => {
    identityMock.mockRejectedValue(new AxiError("not signed in", "AUTH_REQUIRED", ["Run `az login`"]));
    allMock.mockRejectedValue(new AxiError("boom", "API_ERROR", ["requestId: r1"]));
    const result = await run([]);
    expect(result.identity).toBe("-");
    expect(result.subscriptions).toBe("-");
    const help = (result.help as string[]).join("\n");
    expect(help).toContain("[identity]");
    expect(help).toContain("[subscriptions]");
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
