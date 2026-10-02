// Dry runs for api writes (PLAN.md Section 6.13.3) through the real client with
// fetch stubbed: every write and destructive path must never send a non-GET
// request, except the deployment what-if (a query-class POST).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCredentialCache } from "../src/lib/auth.js";
import { classifyRequest } from "../src/lib/policy.js";
import { run } from "../src/commands/api.js";

const SUB = "00000000-0000-0000-0000-000000000021";
const SUB_PATH = `/subscriptions/${SUB}`;
const RG = `${SUB_PATH}/resourceGroups/rg-demo`;
const STORAGE = `${RG}/providers/Microsoft.Storage/storageAccounts/stdemo`;
const MISSING = `${RG}/providers/Microsoft.Storage/storageAccounts/stdemo-missing`;
const DEPLOYMENT = `${RG}/providers/Microsoft.Resources/deployments/dep1`;
const VM_RESTART = `${RG}/providers/Microsoft.Compute/virtualMachines/vm1/restart`;
const CHECK_ACCESS = `${SUB_PATH}/providers/Microsoft.Authorization/checkAccess`;
const OUT_OF_SCOPE = `/subscriptions/00000000-0000-0000-0000-000000000022/resourceGroups/rg-x`;
const MG_PATH = `/providers/Microsoft.Management/managementGroups/mg-demo`;
const API_VERSION = "2023-01-01";
const ETAG = 'W/"etag-1"';

const STORAGE_CURRENT = {
  name: "stdemo",
  type: "Microsoft.Storage/storageAccounts",
  location: "westus",
  tags: { env: "dev", team: "a" },
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-ms-request-id": "req-1", ...headers },
  });
const armError = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

let dir: string;
let locksMode: "some" | "none" | "fail" = "some";
const fetchMock = vi.fn();

const ENV_KEYS = [
  "AZ_AXI_CONFIG",
  "AZ_AXI_PROFILE",
  "AZ_AXI_SUBSCRIPTION",
  "AZ_AXI_TENANT",
  "AZ_AXI_READ_ONLY",
  "AZ_AXI_ARM_TOKEN",
  "AZ_AXI_LOGS_TOKEN",
  "AZ_AXI_GRAPH_TOKEN",
];
let saved: Record<string, string | undefined>;

async function router(url: string, init?: { method?: string; body?: string }): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const pathname = new URL(url).pathname;
  if (method === "GET" && pathname.toLowerCase() === STORAGE.toLowerCase()) {
    return json(STORAGE_CURRENT, 200, { etag: ETAG });
  }
  if (method === "GET" && pathname.toLowerCase() === RG.toLowerCase()) {
    return json({ name: "rg-demo", type: "Microsoft.Resources/resourceGroups", location: "westus", tags: {} }, 200, {
      etag: ETAG,
    });
  }
  if (method === "GET" && pathname.toLowerCase().endsWith("/providers/microsoft.authorization/locks")) {
    if (locksMode === "fail") return armError(403, "AuthorizationFailed", "denied");
    return json({ value: locksMode === "some" ? [{ name: "lock1" }, { name: "lock2" }] : [] });
  }
  if (method === "POST" && pathname.toLowerCase().endsWith("/whatif")) {
    return json({ properties: { changes: [{ changeType: "Create" }, { changeType: "Modify" }, { changeType: "NoChange" }] } });
  }
  if (method === "GET") return armError(404, "ResourceNotFound", "not here");
  return armError(400, "BadRequest", "unexpected non-GET in test router");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-dryrun-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      defaultProfile: "default",
      profiles: {
        default: { auth: "token" },
        writer: { auth: "token", allowWrites: true, subscriptions: [SUB] },
      },
    }),
  );
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  process.env.AZ_AXI_ARM_TOKEN = "dryrun-test-token";
  clearCredentialCache();
  locksMode = "some";
  fetchMock.mockReset();
  fetchMock.mockImplementation(router);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Every fetch call is a GET, except POSTs to a what-if path (a query request). */
function assertOnlyPreviewReads() {
  for (const [url, init] of fetchMock.mock.calls as Array<[string, { method?: string } | undefined]>) {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") continue;
    const pathname = new URL(url).pathname.toLowerCase();
    expect(`${method} ${pathname}`).toBe(`POST ${pathname}`);
    expect(pathname.endsWith("/whatif")).toBe(true);
  }
}

const patch = (extra: string[] = [], profile = "--profile writer") =>
  run(["PATCH", STORAGE, "--api-version", API_VERSION, "--body", '{"tags":{"env":"prod","team":"a"}}', ...profile.split(" "), ...extra]);

function commandArguments(command: string): string[] {
  return execFileSync("sh", ["-c", `az-axi() { printf '%s\\0' "$@"; }; ${command.slice(1, -1)}`], { encoding: "utf8" })
    .split("\0").slice(0, -1);
}

describe("default profile", () => {
  it.each([
    ["PUT", STORAGE, '{"tags":{}}'],
    ["PATCH", RG, '{"tags":{"axi-test":"1"}}'],
    ["POST", CHECK_ACCESS, '{"resource":"x"}'],
    ["DELETE", STORAGE, undefined],
    ["POST", VM_RESTART, undefined],
    ["PUT", `${SUB_PATH}/providers/Microsoft.Authorization/roleAssignments/ra1`, "{}"],
  ])("%s %s sends nothing and reports WRITES_DISABLED", async (method, path, body) => {
    const args = [method, path, "--api-version", API_VERSION, ...(body ? ["--body", body] : [])];
    await expect(run(args)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockClear();
  });

  it("blocks destructive paths without a subscription segment before anything is sent", async () => {
    await expect(run(["PUT", MG_PATH, "--api-version", API_VERSION, "--body", "{}"])).rejects.toMatchObject({
      code: "WRITES_DISABLED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks credential-returning actions as READ_ONLY without sending", async () => {
    await expect(
      run(["POST", `${STORAGE}/listKeys`, "--api-version", API_VERSION, "--body", "{}"]),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("write-enabled profile without --execute", () => {
  it("previews a PATCH diff with the etag and the exact execute command", async () => {
    const result = await patch();
    expect(result).toMatchObject({
      dryRun: true,
      class: "write",
      method: "PATCH",
      subscription: SUB,
      etag: ETAG,
      changes: [{ path: "tags.env", from: "dev", to: "prod" }],
    });
    expect(result.target).toContain("stdemo");
    const help = (result.help as string[]).join("\n");
    expect(help).toContain("--execute");
    expect(help).toContain("--if-match");
    assertOnlyPreviewReads();
  });

  it("reports a no-op when the PATCH body matches the current state", async () => {
    const result = await run([
      "PATCH",
      STORAGE,
      "--api-version",
      API_VERSION,
      "--body",
      JSON.stringify({ tags: { env: "dev", team: "a" } }),
      "--profile",
      "writer",
    ]);
    expect(result).toMatchObject({ dryRun: true, noop: true, changes: [] });
    expect((result.help as string[]).join("\n")).toContain("--execute");
    assertOnlyPreviewReads();
  });

  it("reports creates for a PUT to a missing resource", async () => {
    const result = await run(["PUT", MISSING, "--api-version", API_VERSION, "--body", '{"tags":{}}', "--profile", "writer"]);
    expect(result).toMatchObject({ dryRun: true, creates: true });
    assertOnlyPreviewReads();
  });

  it("lists removed fields for a PUT", async () => {
    const result = await run([
      "PUT",
      STORAGE,
      "--api-version",
      API_VERSION,
      "--body",
      JSON.stringify({ tags: { env: "dev", team: "a" } }),
      "--profile",
      "writer",
    ]);
    const changes = result.changes as Array<Record<string, unknown>>;
    expect(changes).toContainEqual({ path: "location", from: "westus" });
    assertOnlyPreviewReads();
  });

  it("summarizes a DELETE with its locks and the confirm command", async () => {
    const result = await run(["DELETE", STORAGE, "--api-version", API_VERSION, "--profile", "writer"]);
    expect(result).toMatchObject({
      dryRun: true,
      class: "destructive",
      summary: { name: "stdemo", type: "Microsoft.Storage/storageAccounts", location: "westus", tags: 2 },
    });
    expect(String(result.lockWarning)).toContain("lock1");
    const help = (result.help as string[]).join("\n");
    expect(help).toContain("--execute");
    expect(help).toContain("--confirm stdemo");
    assertOnlyPreviewReads();
  });

  it("omits the lock warning when no locks exist", async () => {
    locksMode = "none";
    const result = await run(["DELETE", STORAGE, "--api-version", API_VERSION, "--profile", "writer"]);
    expect(result.lockWarning).toBeUndefined();
    assertOnlyPreviewReads();
  });

  it("degrades to a hint when the lock check fails", async () => {
    locksMode = "fail";
    const result = await run(["DELETE", STORAGE, "--api-version", API_VERSION, "--profile", "writer"]);
    expect(result.lockWarning).toBeUndefined();
    expect((result.help as string[]).join("\n")).toContain("Could not check resource locks");
    assertOnlyPreviewReads();
  });

  it("summarizes a deployment PUT through what-if, a query-class POST", async () => {
    expect(
      classifyRequest({ resource: "arm", method: "POST", path: `${DEPLOYMENT}/whatIf` }),
    ).toBe("query");
    const result = await run([
      "PUT",
      DEPLOYMENT,
      "--api-version",
      API_VERSION,
      "--body",
      JSON.stringify({ location: "westus", properties: { mode: "Incremental", template: {} } }),
      "--profile",
      "writer",
    ]);
    expect(result).toMatchObject({ dryRun: true, whatIf: { create: 1, modify: 1, nochange: 1 } });
    const nonGet = (fetchMock.mock.calls as Array<[string, { method?: string }]>).filter(
      ([, init]) => (init?.method ?? "GET").toUpperCase() !== "GET",
    );
    expect(nonGet).toHaveLength(1);
    expect(new URL(nonGet[0]?.[0] as string).pathname.toLowerCase().endsWith("/whatif")).toBe(true);
  });

  it("previews a plain POST write without any preview call", async () => {
    const result = await run(["POST", CHECK_ACCESS, "--api-version", API_VERSION, "--body", '{"resource":"x"}', "--profile", "writer"]);
    expect(result).toMatchObject({ dryRun: true, class: "write", method: "POST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry-runs a destructive action without --confirm instead of demanding it", async () => {
    const result = await run(["POST", VM_RESTART, "--api-version", API_VERSION, "--profile", "writer"]);
    expect(result).toMatchObject({ dryRun: true, class: "destructive" });
    expect((result.help as string[]).join("\n")).toContain("--confirm vm1");
    assertOnlyPreviewReads();
  });

  it("redacts the previewed body and truncates it unless --full", async () => {
    const big = `{\"adminPassword\":\"hunter2\",\"blob\":\"${"x".repeat(5000)}\"}`;
    const short = await run(["PATCH", STORAGE, "--api-version", API_VERSION, "--body", '{"adminPassword":"hunter2"}', "--profile", "writer"]);
    expect(JSON.stringify(short.body)).toContain("***redacted***");
    expect(JSON.stringify(short.body)).not.toContain("hunter2");
    expect(JSON.stringify(short)).not.toContain("hunter2");
    expect(short.changes).toEqual([{ path: "adminPassword", to: "***redacted***" }]);
    expect((short.help as string[]).join("\n")).toContain("--body '<json-body>'");

    const truncated = await run(["PATCH", STORAGE, "--api-version", API_VERSION, "--body", big, "--profile", "writer"]);
    expect(typeof truncated.body).toBe("string");
    expect(String(truncated.body)).toContain("truncated");

    const full = await run([
      "PATCH",
      STORAGE,
      "--api-version",
      API_VERSION,
      "--body",
      big,
      "--profile",
      "writer",
      "--full",
    ]);
    expect(typeof full.body).toBe("object");
    assertOnlyPreviewReads();
  });

  it.each(["PUT", "PATCH"])("redacts %s changes without hiding secret replacements", async (method) => {
    fetchMock.mockResolvedValue(json({ properties: { adminPassword: "old-password", nested: { clientSecret: "old-secret" } }, passwords: [{ name: "login", value: "old-pair" }] }));
    const result = await run([method, STORAGE, "--api-version", API_VERSION, "--profile", "writer", "--body",
      JSON.stringify({ properties: { adminPassword: "new-password", nested: { clientSecret: "new-secret" } }, passwords: [{ name: "login", value: "new-pair" }] })]);
    expect(result.noop).toBeUndefined();
    expect(result.changes).toEqual([
      { path: "properties.adminPassword", from: "***redacted***", to: "***redacted***" },
      { path: "properties.nested.clientSecret", from: "***redacted***", to: "***redacted***" },
      { path: "passwords", from: [{ name: "login", value: "***redacted***" }], to: [{ name: "login", value: "***redacted***" }] },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/old-password|new-password|old-secret|new-secret|old-pair|new-pair/);
    assertOnlyPreviewReads();
  });

  it("redacts removed PUT secrets", async () => {
    fetchMock.mockResolvedValue(json({ properties: { adminPassword: "removed-password" } }));
    const result = await run(["PUT", STORAGE, "--api-version", API_VERSION, "--profile", "writer", "--body", "{}"]);
    expect(result.changes).toEqual([{ path: "properties.adminPassword", from: "***redacted***" }]);
    expect(JSON.stringify(result)).not.toContain("removed-password");
    assertOnlyPreviewReads();
  });

  it.each([["PUT", MISSING], ["POST", CHECK_ACCESS], ["DELETE", STORAGE], ["PUT", DEPLOYMENT]])(
    "keeps secret bodies out of %s %s command hints", async (method, path) => {
      const result = await run([method, path, "--api-version", API_VERSION, "--profile", "writer", "--body", '{"adminPassword":"hunter2"}']);
      expect(JSON.stringify(result)).not.toContain("hunter2");
      expect((result.help as string[]).join("\n")).toContain("--body '<json-body>'");
      assertOnlyPreviewReads();
    },
  );

  it.each([DEPLOYMENT, `${SUB_PATH}/providers/Microsoft.Resources/deployments/dep1`])(
    "preserves effective deployment queries for %s", async (path) => {
      for (const [suffix, flags, version] of [
        [`?api-version=path-version&keep=path`, [], "path-version"],
        ["?keep=path", ["--query", "api-version=query-version&keep=query"], "query-version"],
        ["?api-version=path-version&keep=path", ["--api-version", "flag-version", "--query", "keep=query"], "path-version"],
        ["?api-version=path-version&keep=path", ["--api-version", "flag-version", "--query", "api-version=query-version"], "query-version"],
      ] as const) {
        fetchMock.mockClear();
        const result = await run(["PUT", `${path}${suffix}`, ...flags, "--profile", "writer", "--body", '{"properties":{"template":{}}}']);
        expect(result.whatIf).toEqual({ create: 1, modify: 1, nochange: 1 });
        const url = new URL(fetchMock.mock.calls[0]![0] as string);
        expect(url.pathname).toBe(`${path}/whatIf`);
        expect(url.searchParams.get("api-version")).toBe(version);
        expect(url.searchParams.get("keep")).toBe(flags.some((flag) => flag === "keep=query") ? "query" : "path");
        assertOnlyPreviewReads();
      }
    },
  );
});

describe("canonical request paths", () => {
  it.each([
    ["PATCH", STORAGE, '{"tags":{"env":"prod"}}'],
    ["PUT", MISSING, "{}"],
    ["DELETE", STORAGE, undefined],
    ["POST", VM_RESTART, undefined],
    ["PUT", DEPLOYMENT, '{"properties":{"template":{}}}'],
    ["PUT", `${SUB_PATH}/providers/Microsoft.Resources/deployments/dep1`, '{"properties":{"template":{}}}'],
    ...["roleAssignments", "roleDefinitions", "locks", "policyAssignments"].map((type) =>
      ["PUT", `${SUB_PATH}/providers/Microsoft.Authorization/${type}/assignment1`, "{}"],
    ),
  ])("preserves %s %s previews across path representations", async (method, path, body) => {
    const flags = ["--profile", "writer", "--api-version", "flag-version", "--query", "keep=query&extra=1", ...(body === undefined ? [] : ["--body", body])];
    const suffix = "?api-version=path-version&keep=path";
    const reference = await run([method!, `${path}${suffix}`, ...flags]);
    const requests = () => fetchMock.mock.calls.map(([url, init]) => ({ url, method: init.method, body: init.body }));
    const referenceRequests = requests();
    for (const representation of [path!.slice(1), `https://management.azure.com${path}`]) {
      fetchMock.mockClear();
      expect(await run([method!, `${representation}${suffix}`, ...flags])).toEqual(reference);
      expect(requests()).toEqual(referenceRequests);
      for (const { url } of requests()) {
        const parsed = new URL(url as string);
        if (parsed.pathname.endsWith("/locks")) continue;
        expect(parsed.searchParams.get("api-version")).toBe("path-version");
        expect(parsed.searchParams.get("keep")).toBe("query");
        expect(parsed.searchParams.get("extra")).toBe("1");
      }
      assertOnlyPreviewReads();
    }
  });

  it("gates the normalized subscription after dot-segment resolution", async () => {
    await expect(run(["PATCH", `${SUB_PATH}/../00000000-0000-0000-0000-000000000022/resourceGroups/rg-x`, "--api-version", API_VERSION, "--profile", "writer", "--body", "{}"])).rejects.toMatchObject({ code: "SUBSCRIPTION_NOT_WRITABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["http://management.azure.com", "https://other.example"])(
    "rejects a write URL on %s before previewing", async (host) => {
      await expect(run(["PATCH", `${host}${STORAGE}`, "--api-version", API_VERSION, "--profile", "writer", "--body", "{}"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("selected preview regressions", () => {
  it("replays a DELETE preview for a name beginning with --", async () => {
    fetchMock.mockImplementation(async () => json({ name: "--prod" }));
    const result = await run(["DELETE", `${SUB_PATH}/resourceGroups/--prod`, "--api-version", API_VERSION, "--profile", "writer"]);
    const command = (result.help as string[]).find((hint) => hint.startsWith("`az-axi api"))!;
    fetchMock.mockClear();
    await expect(run(commandArguments(command).slice(1))).rejects.toMatchObject({ code: "API_ERROR", message: expect.stringContaining("execution is not available yet") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replays a preview with a profile name beginning with --", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { "--writer": { auth: "token", allowWrites: true, subscriptions: [SUB] } } }));
    const result = await run(["PATCH", STORAGE, "--api-version", API_VERSION, "--profile=--writer", "--body", "{}"]);
    const command = (result.help as string[]).find((hint) => hint.startsWith("`az-axi api"))!;
    fetchMock.mockClear();
    await expect(run(commandArguments(command).slice(1))).rejects.toMatchObject({ code: "API_ERROR", message: expect.stringContaining("execution is not available yet") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["roleAssignments", "roleDefinitions", "locks", "policyAssignments"])(
    "includes executable confirmation in every %s preview", async (type) => {
      const path = `${SUB_PATH}/providers/Microsoft.Authorization/${type}/assignment1`;
      for (const method of ["PUT", "PATCH"] as const) {
        for (const body of [undefined, "{}", '{"properties":{"enabled":true}}']) {
          fetchMock.mockResolvedValue(json({}, 200, { etag: ETAG }));
          const result = await run([method, path, "--api-version", API_VERSION, "--profile", "writer", ...(body === undefined ? [] : ["--body", body])]);
          expect(result.class).toBe("destructive");
          const command = (result.help as string[]).find((hint) => hint.startsWith("`az-axi api"))!;
          const argv = commandArguments(command);
          expect(argv.slice(-2)).toEqual(["--confirm", "assignment1"]);
          fetchMock.mockClear();
          await expect(run(argv.slice(1))).rejects.toMatchObject({ code: "API_ERROR", message: expect.stringContaining("execution is not available yet") });
          expect(fetchMock).not.toHaveBeenCalled();
        }
      }
      fetchMock.mockResolvedValue(armError(404, "ResourceNotFound", "not here"));
      const created = await run(["PUT", path, "--api-version", API_VERSION, "--profile", "writer", "--body", "{}"]);
      expect(created.creates).toBe(true);
      const argv = commandArguments((created.help as string[])[0]!);
      expect(argv.slice(-2)).toEqual(["--confirm", "assignment1"]);
      fetchMock.mockClear();
      await expect(run(argv.slice(1))).rejects.toMatchObject({ code: "API_ERROR", message: expect.stringContaining("execution is not available yet") });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([RG, SUB_PATH])("previews a deployment named whatIf under %s", async (scope) => {
    const path = `${scope}/providers/Microsoft.Resources/deployments/whatIf`;
    const result = await run(["PUT", path, "--api-version", API_VERSION, "--profile", "writer", "--body", '{"properties":{"template":{}}}']);
    expect(result.whatIf).toEqual({ create: 1, modify: 1, nochange: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0]![0] as string).pathname).toBe(`${path}/whatIf`);
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });

  it("keeps deployment action PUTs on the ordinary preview path", async () => {
    const result = await run(["PUT", `${DEPLOYMENT}/whatIf`, "--api-version", API_VERSION, "--profile", "writer", "--body", "{}"]);
    expect(result.creates).toBe(true);
    expect(result.whatIf).toBeUndefined();
    assertOnlyPreviewReads();
  });

  it.each([DEPLOYMENT, `${SUB_PATH}/providers/Microsoft.Resources/deployments/dep1`])(
    "handles pending, failed and successful what-if responses for %s", async (path) => {
      const argv = ["PUT", path, "--api-version", API_VERSION, "--profile", "writer", "--body", '{"properties":{"template":{}}}'];
      const operationUrl = `https://management.azure.com${SUB_PATH}/operations/op1?api-version=1&label=a'b`;
      for (const [httpStatus, status] of [[202, undefined], [202, "Succeeded"], [200, "Running"]] as const) {
        fetchMock.mockClear();
        fetchMock.mockResolvedValue(json({ status, properties: { changes: [] } }, httpStatus, { location: operationUrl, "retry-after": "10" }));
        const result = await run(argv);
        expect(result).toMatchObject({ dryRun: true, pending: true, operationUrl });
        expect(result.whatIf).toBeUndefined();
        expect(result.help).toHaveLength(1);
        expect(commandArguments((result.help as string[])[0]!)).toEqual(["op", "status", operationUrl, "--profile", "writer"]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
      for (const body of [
        { status: "Failed", error: { code: "InvalidTemplate", message: "bad template" } },
        { status: "Canceled" },
        { status: "Succeeded", error: { code: "InvalidTemplate", message: "bad template" }, properties: { changes: [] } },
      ]) {
        fetchMock.mockClear();
        fetchMock.mockResolvedValue(json(body));
        await expect(run(argv)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
      fetchMock.mockResolvedValue(json({ status: "Failed", error: { code: "InvalidTemplate", message: "bad template" } }));
      await expect(run(argv)).rejects.toThrowError("InvalidTemplate): bad template");
      fetchMock.mockResolvedValue(json({ status: "Succeeded" }));
      await expect(run(argv)).rejects.toMatchObject({ code: "API_ERROR" });
      fetchMock.mockResolvedValue(json({}, 202));
      await expect(run(argv)).rejects.toMatchObject({ code: "API_ERROR", message: expect.stringContaining("no operation URL") });
      fetchMock.mockResolvedValue(json({ status: "Succeeded", properties: { changes: [] } }));
      const unchanged = await run(argv);
      expect(unchanged.whatIf).toEqual({});
      expect((unchanged.help as string[]).join("\n")).toContain("--execute");
      fetchMock.mockResolvedValue(json({ status: "Succeeded", properties: { changes: [{ changeType: "Create" }, { changeType: "Create" }, { changeType: "Delete" }, { changeType: "Modify" }, { changeType: "NoChange" }] } }));
      const changed = await run(argv);
      expect(changed.whatIf).toEqual({ create: 2, delete: 1, modify: 1, nochange: 1 });
      expect((changed.help as string[]).join("\n")).toContain("--execute");
      assertOnlyPreviewReads();
    },
  );
});

describe("write-enabled profile with --execute", () => {
  it("reports that execution is not available yet and sends nothing", async () => {
    await expect(patch(["--execute"])).rejects.toMatchObject({ code: "API_ERROR" });
    await expect(patch(["--execute"])).rejects.toThrowError(/execution is not available yet/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still demands --confirm for destructive requests before the execute error", async () => {
    await expect(
      run(["DELETE", STORAGE, "--api-version", API_VERSION, "--profile", "writer", "--execute"]),
    ).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
    await expect(
      run(["DELETE", STORAGE, "--api-version", API_VERSION, "--profile", "writer", "--execute", "--confirm", "wrong"]),
    ).rejects.toMatchObject({ code: "CONFIRM_MISMATCH" });
    await expect(
      run(["DELETE", STORAGE, "--api-version", API_VERSION, "--profile", "writer", "--execute", "--confirm", "stdemo"]),
    ).rejects.toMatchObject({ code: "API_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks out-of-scope and read-only-forced writes before anything is sent", async () => {
    await expect(
      run(["PATCH", OUT_OF_SCOPE, "--api-version", API_VERSION, "--body", "{}", "--profile", "writer", "--execute"]),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_NOT_WRITABLE" });
    process.env.AZ_AXI_READ_ONLY = "1";
    await expect(patch(["--execute"])).rejects.toMatchObject({ code: "WRITES_DISABLED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
