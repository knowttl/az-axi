import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/auth.js", () => ({
  runAz: vi.fn(),
  identityOf: vi.fn(),
  resolveCredential: vi.fn(),
}));
vi.mock("../src/lib/client.js", () => ({ requestAll: vi.fn() }));

import { run } from "../src/commands/doctor.js";
import { identityOf, resolveCredential, runAz } from "../src/lib/auth.js";
import { requestAll } from "../src/lib/client.js";

const SUB_A = "00000000-0000-0000-0000-000000000020";
const TENANT = "00000000-0000-0000-0000-000000000001";

const runAzMock = vi.mocked(runAz);
const identityMock = vi.mocked(identityOf);
const credentialMock = vi.mocked(resolveCredential);
const requestAllMock = vi.mocked(requestAll);

let dir: string;
let path: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_READ_ONLY", "AZ_AXI_TENANT", "AZ_AXI_SUBSCRIPTION"];
let saved: Record<string, string | undefined>;

const rows = async (argv: string[] = []) => (await run(argv)).profiles as Array<Record<string, unknown>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-doctor-"));
  path = join(dir, "config.json");
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = path;
  vi.resetAllMocks();
  runAzMock.mockResolvedValue("{}");
  identityMock.mockResolvedValue({ name: "ada@contoso.com", type: "user", tenantId: TENANT });
  credentialMock.mockResolvedValue({ header: "Bearer x", mode: "az" });
  requestAllMock.mockResolvedValue({ items: [{}, {}, {}] });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("doctor", () => {
  it("checks the implicit az profile when there is no config", async () => {
    const result = await run([]);
    expect(result.package).toMatch(/az-axi \d+\.\d+\.\d+/);
    expect(String(result.config)).toContain("implicit az profile");
    expect(result.profiles).toEqual([
      { name: "az", auth: "az", identity: "ada@contoso.com", type: "user", subscriptions: 3, writes: "disabled (default)", status: "ok" },
    ]);
    expect(credentialMock.mock.calls.map(([, resource]) => resource)).toEqual(["arm", "logs", "graph"]);
    expect(requestAllMock).toHaveBeenCalledWith(expect.anything(), { path: "/subscriptions", apiVersion: "2022-12-01" });
  });

  it("reports the identity type for service principals and managed identities", async () => {
    identityMock.mockResolvedValue({ name: "systemAssignedIdentity", type: "managedIdentity", tenantId: TENANT });
    expect((await rows())[0]).toMatchObject({ identity: "systemAssignedIdentity", type: "managedIdentity" });
  });

  it("reports every configured profile, with write status per profile", async () => {
    writeFileSync(
      path,
      JSON.stringify({
        defaultProfile: "work",
        profiles: {
          work: { auth: "az" },
          sandbox: { auth: "az", subscriptions: [SUB_A], allowWrites: true },
          ci: { auth: "token" },
        },
      }),
    );
    const result = await rows();
    expect(result.map((row) => [row.name, row.writes, row.status])).toEqual([
      ["work", "disabled (default)", "ok"],
      ["sandbox", "ENABLED for 1 subscription", "ok"],
      ["ci", "disabled (default)", "ok"],
    ]);
    expect(result[2]).toMatchObject({ identity: "(token)", type: "token" });
    // token mode never spawns az
    expect(runAzMock).toHaveBeenCalledTimes(2);
  });

  it("shows write status forced off by $AZ_AXI_READ_ONLY", async () => {
    writeFileSync(path, JSON.stringify({ profiles: { sandbox: { auth: "az", subscriptions: [SUB_A], allowWrites: true } } }));
    process.env.AZ_AXI_READ_ONLY = "1";
    expect((await rows())[0]?.writes).toBe("disabled (AZ_AXI_READ_ONLY)");
  });

  it("restricts the check to --profile", async () => {
    writeFileSync(path, JSON.stringify({ profiles: { a: { auth: "az" }, b: { auth: "az" } } }));
    expect((await rows(["--profile", "b"])).map((row) => row.name)).toEqual(["b"]);
  });

  it("reports an invalid profile without failing the whole check", async () => {
    writeFileSync(path, JSON.stringify({ profiles: { bad: { auth: "az", allowWrites: true }, good: { auth: "az" } } }));
    const result = await run([]);
    const [bad, good] = result.profiles as Array<Record<string, unknown>>;
    expect(bad?.status).toMatch(/^invalid: .*subscriptions/);
    expect(good?.status).toBe("ok");
    expect((result.help as string[]).every((line) => line.startsWith("[bad] "))).toBe(true);
  });

  it("fails clearly when az is not installed and skips the az-dependent checks", async () => {
    runAzMock.mockRejectedValue(new Error("az CLI is not installed or not on PATH"));
    const result = await run([]);
    expect((result.profiles as Array<Record<string, unknown>>)[0]?.status).toBe("failed: az");
    expect(identityMock).not.toHaveBeenCalled();
    expect(credentialMock).not.toHaveBeenCalled();
    expect((result.help as string[]).join("\n")).toContain("[az] az CLI is not installed or not on PATH");
  });

  it("records a present az CLI failure instead of diagnosing it as missing", async () => {
    runAzMock.mockRejectedValue(new Error("az exited with code 1"));
    const result = await run([]);
    const help = (result.help as string[]).join("\n");
    expect((result.profiles as Array<Record<string, unknown>>)[0]?.status).toBe("failed: az");
    expect(help).toContain("[az] az exited with code 1");
    expect(help).not.toContain("not installed");
    expect(identityMock).not.toHaveBeenCalled();
    expect(credentialMock).not.toHaveBeenCalled();
  });

  it("fails when signed out and prefixes the fix with the profile name", async () => {
    identityMock.mockRejectedValue(new AxiError("not signed in to Azure CLI (profile 'az')", "AUTH_REQUIRED", ["Run `az login`"]));
    credentialMock.mockRejectedValue(new AxiError("not signed in to Azure CLI (profile 'az')", "AUTH_REQUIRED", ["Run `az login`"]));
    const result = await run([]);
    expect((result.profiles as Array<Record<string, unknown>>)[0]).toMatchObject({
      identity: "-",
      subscriptions: "-",
      status: "failed: sign-in, arm token, logs token",
    });
    // Duplicate failures collapse to one hint line.
    expect((result.help as string[]).filter((line) => line === "[az] Run `az login`")).toHaveLength(1);
    expect(requestAllMock).not.toHaveBeenCalled();
  });

  it("treats a missing graph token as optional", async () => {
    credentialMock.mockImplementation(async (_profile, resource) => {
      if (resource === "graph") throw new AxiError("no graph token", "AUTH_REQUIRED", ["Set $AZ_AXI_GRAPH_TOKEN"]);
      return { header: "Bearer x", mode: "az" };
    });
    expect((await rows())[0]?.status).toBe("ok (graph token unavailable)");
  });

  it("flags a TLS failure when ARM is unreachable", async () => {
    requestAllMock.mockRejectedValue(new AxiError("TLS certificate verification failed", "TLS_ERROR", ["Set NODE_EXTRA_CA_CERTS to the path of your organization's root CA (PEM)"]));
    const result = await run([]);
    expect((result.profiles as Array<Record<string, unknown>>)[0]?.status).toBe("failed: arm reachable (tls)");
    expect((result.help as string[]).join("\n")).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("marks a truncated subscription count", async () => {
    requestAllMock.mockResolvedValue({ items: [{}, {}], nextLink: "https://management.azure.com/next" });
    expect((await rows())[0]?.subscriptions).toBe("2+");
  });

  it("rejects stray arguments and unknown flags", async () => {
    await expect(run(["extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["--org", "x"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
  });
});
