import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/api.js";
import { ApiRequestError, sendRequest, type ApiResponse } from "../src/lib/client.js";
import type { ResolvedProfile } from "../src/lib/config.js";
import { appendWriteLog } from "../src/lib/writeLog.js";
import { identityOf } from "../src/lib/auth.js";

vi.mock("../src/lib/client.js", async (original) => ({
  ...await original<typeof import("../src/lib/client.js")>(), sendRequest: vi.fn(),
}));
vi.mock("../src/lib/writeLog.js", () => ({ appendWriteLog: vi.fn() }));
vi.mock("../src/lib/context.js", () => ({ profileFromArgs: () => profile }));
vi.mock("../src/lib/auth.js", async (original) => ({
  ...await original<typeof import("../src/lib/auth.js")>(), identityOf: vi.fn(),
}));

const SUB = "00000000-0000-0000-0000-000000000021";
const TARGET = `/subscriptions/${SUB}/resourceGroups/rg-demo`;
const OPERATION = `https://management.azure.com/subscriptions/${SUB}/operations/op1?api-version=1`;
let profile: ResolvedProfile;
const send = vi.mocked(sendRequest);
const log = vi.mocked(appendWriteLog);
// source: Resource Groups - Get response and Track asynchronous Azure operations (synthetic IDs).
const response = (body: unknown = {}, status = 200, headers: Record<string, string> = {}): ApiResponse<unknown> => ({
  body, status, headers, requestId: "req-write", correlationId: "corr-write", clientRequestId: "client-write",
});
const execute = (extra: string[] = [], method = "PATCH", body = '{"tags":{"env":"prod"}}') =>
  run([method, TARGET, "--api-version", "1", "--body", body, "--execute", ...extra]);

beforeEach(() => {
  vi.stubEnv("AZ_AXI_READ_ONLY", "");
  profile = { name: "writer", source: "implicit", auth: "token", allowWrites: true,
    subscriptions: [SUB], writeSubscriptions: [SUB] };
  send.mockReset();
  log.mockReset();
  vi.mocked(identityOf).mockReset().mockResolvedValue({ name: "analyst@contoso.com", type: "user", tenantId: "00000000-0000-0000-0000-000000000001" });
  send.mockResolvedValueOnce(response({ tags: { env: "dev" }, etag: '"body-etag"' }, 200, { etag: '"fresh"' }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("API write execution", () => {
  it.each(["delete", "DELETE", "%64elete/?api-version=1"])("requires VMSS confirmation for POST %s", async (action) => {
    const path = `${TARGET}/providers/Microsoft.Compute/virtualMachineScaleSets/scale1/${action}`;
    const argv = ["POST", path, "--api-version", "1", "--body", '{"instanceIds":["0"]}'];
    const preview = await run(argv);
    expect(preview).toMatchObject({ dryRun: true, class: "destructive" });
    expect(preview.help).toContainEqual(expect.stringContaining("--confirm scale1"));
    expect(send).not.toHaveBeenCalled();
    for (const confirm of [undefined, "wrong", "delete"]) {
      await expect(run([...argv, "--execute", ...(confirm === undefined ? [] : ["--confirm", confirm])]))
        .rejects.toMatchObject({ code: confirm === undefined ? "CONFIRM_REQUIRED" : "CONFIRM_MISMATCH" });
      expect(send).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    }
    send.mockResolvedValueOnce(response());
    expect(await run([...argv, "--execute", "--confirm", "scale1"])).toMatchObject({ result: "done" });
    expect(send.mock.calls[1]?.[1]).toMatchObject({ method: "POST", execute: true, confirm: "scale1", body: { instanceIds: ["0"] } });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ class: "destructive", method: "POST" }));
  });

  it.each(["listClusterAdminCredential", "listClusterUserCredential"])("never previews or executes AKS %s", async (action) => {
    for (const representation of [action, action.toUpperCase(), `%6C${action.slice(1)}/?api-version=1`]) {
      const path = `${TARGET}/providers/Microsoft.ContainerService/managedClusters/cluster1/${representation}`;
      for (const flags of [[], ["--execute", "--confirm", "cluster1"]]) {
        await expect(run(["POST", path, "--api-version", "1", ...flags])).rejects.toMatchObject({ code: "READ_ONLY" });
        expect(send).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
      }
    }
  });

  it.each([200, 201, 204])("finishes a synchronous %s write with trace metadata and GET help", async (status) => {
    send.mockResolvedValueOnce(response({}, status));
    const result = await execute(["--if-match", '"reviewed"']);
    expect(result).toMatchObject({ result: "done", status, target: expect.any(String),
      requestId: "req-write", correlationId: "corr-write", durationSec: expect.any(Number) });
    expect(send.mock.calls.map((call) => call[1].method ?? "GET")).toEqual(["GET", "PATCH"]);
    expect(send.mock.calls[1]?.[1]).toMatchObject({ ifMatch: '"reviewed"', execute: true, body: { tags: { env: "prod" } } });
    expect(result.protection).toBeUndefined();
    expect(result.help).toEqual([expect.stringContaining(`az-axi api GET '${TARGET}?api-version=1'`)]);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      profile: "writer", identity: "token (identity unavailable)", class: "write", method: "PATCH",
      url: `https://management.azure.com${TARGET}?api-version=1`, requestId: "req-write",
      correlationId: "corr-write", httpStatus: status, outcome: "success",
    }));
    expect(log.mock.calls[0]?.[0]).not.toHaveProperty("body");
    expect(log.mock.calls[0]?.[0]).not.toHaveProperty("headers");
  });

  it.each([
    [{ etag: '"fresh"' }, '"fresh"'], [{}, '"body-etag"'],
  ])("uses the fresh ETag without reviewed protection (%j)", async (headers, etag) => {
    send.mockReset().mockResolvedValueOnce(response({ tags: {}, etag: '"body-etag"' }, 200, headers))
      .mockResolvedValueOnce(response());
    const result = await execute();
    expect(send.mock.calls[1]?.[1].ifMatch).toBe(etag);
    expect(result.protection).toBe("review-to-execute protection was not used");
  });

  it("creates a missing PUT resource without inventing an ETag", async () => {
    send.mockReset().mockRejectedValueOnce(new AxiError("gone", "NOT_FOUND", []))
      .mockResolvedValueOnce(response({}, 201));
    expect(await execute([], "PUT")).toMatchObject({ result: "done", status: 201 });
    expect(send.mock.calls[1]?.[1].ifMatch).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });

  it("logs the account identity for az authentication", async () => {
    profile.auth = "az";
    send.mockResolvedValueOnce(response());
    await execute();
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ identity: "analyst@contoso.com" }));
  });

  it.each(["prod", "dev"])("previews and executes tag removals with env=%s", async (env) => {
    const current = response({ tags: { env: "prod", team: "billing" } });
    const body = JSON.stringify({ tags: { env } });
    send.mockReset().mockResolvedValueOnce(current);
    const preview = await run(["PATCH", TARGET, "--api-version", "1", "--body", body]);
    expect(preview.noop).toBeUndefined();
    expect(preview.changes).toContainEqual({ path: "tags.team", from: "billing", to: undefined });
    send.mockReset().mockResolvedValueOnce(current).mockResolvedValueOnce(response());
    expect(await execute([], "PATCH", body)).toMatchObject({ result: "done" });
    expect(send.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH", body: { tags: { env } } });
    expect(log).toHaveBeenCalledOnce();
  });

  it.each([undefined, '"reviewed"'])("executes validation with an absent deployment and ETag %s", async (ifMatch) => {
    const path = `${TARGET}/providers/Microsoft.Resources/deployments/new-deployment/validate`;
    send.mockReset().mockRejectedValueOnce(new ApiRequestError(new AxiError("gone", "NOT_FOUND", []), 404))
      .mockResolvedValueOnce(response());
    expect(await run(["POST", path, "--api-version", "1", "--body", "{}", "--execute",
      ...(ifMatch === undefined ? [] : ["--if-match", ifMatch])])).toMatchObject({ result: "done" });
    expect(send.mock.calls[0]?.[1].path).toBe(`https://management.azure.com${path.slice(0, path.lastIndexOf("/"))}?api-version=1`);
    expect(send.mock.calls[1]?.[1]).toMatchObject({ method: "POST", execute: true, ifMatch });
    expect(log).toHaveBeenCalledOnce();
  });

  it("executes a confirmed destructive POST after a parent 404", async () => {
    send.mockReset().mockRejectedValueOnce(new AxiError("gone", "NOT_FOUND", []))
      .mockResolvedValueOnce(response());
    expect(await run(["POST", `${TARGET}/restart`, "--api-version", "1", "--execute", "--confirm", "rg-demo"]))
      .toMatchObject({ result: "done" });
    expect(send.mock.calls[1]?.[1]).toMatchObject({ execute: true, confirm: "rg-demo", ifMatch: undefined });
    expect(log).toHaveBeenCalledOnce();
  });

  it.each(["PUT", "PATCH", "DELETE"])("skips a %s no-op with no write and no log", async (method) => {
    send.mockReset();
    if (method === "DELETE") send.mockRejectedValueOnce(new AxiError("gone", "NOT_FOUND", []));
    else send.mockResolvedValueOnce(response({ tags: { env: "prod" } }));
    expect(await execute(["--confirm", "rg-demo"], method)).toMatchObject({ result: "already in desired state (no-op)" });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1].method ?? "GET").toBe("GET");
    expect(log).not.toHaveBeenCalled();
  });

  it("compares secret values before redaction when checking a no-op", async () => {
    send.mockReset().mockResolvedValueOnce(response({ password: "before" })).mockResolvedValueOnce(response());
    await execute([], "PATCH", '{"password":"after"}');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(["PATCH", "POST"])("does not send or log %s after a failed state read", async (method) => {
    for (const code of ["FORBIDDEN", "AUTH_REQUIRED", "NETWORK_ERROR"]) {
      send.mockReset().mockRejectedValueOnce(new AxiError("denied", code, []));
      await expect(execute([], method)).rejects.toMatchObject({ code });
      expect(send).toHaveBeenCalledOnce();
    }
    expect(log).not.toHaveBeenCalled();
  });

  it.each([201, 202, 429, 503])("reports and audits received HTTP %s metadata on a body failure", async (status) => {
    send.mockRejectedValueOnce(new ApiRequestError(new AxiError("body interrupted", "NETWORK_ERROR", []), status, "req-body", "corr-body"));
    await expect(execute()).rejects.toMatchObject({ code: "NETWORK_ERROR",
      output: { result: "failed", status, requestId: "req-body", correlationId: "corr-body" } });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ httpStatus: status,
      requestId: "req-body", correlationId: "corr-body", outcome: "NETWORK_ERROR" }));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(["PRECONDITION_FAILED", "CONFLICT", "NETWORK_ERROR"])("logs the %s write failure once", async (code) => {
    const status = code === "PRECONDITION_FAILED" ? 412 : code === "CONFLICT" ? 409 : 0;
    send.mockRejectedValueOnce(new ApiRequestError(new AxiError("failed", code, ["re-run the dry run"]), status, "req-fail", "corr-fail"));
    await expect(execute(["--if-match", '"reviewed"'])).rejects.toMatchObject({ code });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ httpStatus: status,
      outcome: code, requestId: "req-fail", correlationId: "corr-fail" }));
  });

  it.each(["PUT", "PATCH", "POST", "DELETE"])("keeps default profiles and the env override closed for %s", async (method) => {
    profile.allowWrites = false;
    await expect(execute(["--confirm", "rg-demo"], method)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
    profile.allowWrites = true;
    vi.stubEnv("AZ_AXI_READ_ONLY", "1");
    await expect(execute(["--confirm", "rg-demo"], method)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
    expect(send).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([[[]], [["--confirm", "wrong"]]])("blocks destructive execution before reading or logging (%j)", async (flags) => {
    await expect(execute(flags, "DELETE")).rejects.toMatchObject({ code: flags.length ? "CONFIRM_MISMATCH" : "CONFIRM_REQUIRED" });
    expect(send).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("uses the parent's fresh ETag for a destructive POST action", async () => {
    send.mockResolvedValueOnce(response());
    expect(await run(["POST", `${TARGET}/restart/`, "--api-version", "1", "--execute", "--confirm", "rg-demo"]))
      .toMatchObject({ result: "done", help: [expect.stringContaining(`az-axi api GET '${TARGET}?api-version=1'`)] });
    expect(send.mock.calls[0]?.[1].path).toBe(`https://management.azure.com${TARGET}?api-version=1`);
    expect(send.mock.calls[1]?.[1]).toMatchObject({ method: "POST", ifMatch: '"fresh"', confirm: "rg-demo" });
  });

  it("never logs a dry run", async () => {
    const result = await run(["PATCH", TARGET, "--api-version", "1", "--body", '{"tags":{}}']);
    expect(result.dryRun).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it("reports audit failure after the write without retrying it", async () => {
    send.mockResolvedValueOnce(response());
    log.mockImplementationOnce(() => { throw new Error("permission denied"); });
    await expect(execute()).rejects.toMatchObject({ code: "API_ERROR",
      message: "write outcome: success; could not append the write log",
      output: expect.objectContaining({ result: "write log failed", status: 200, requestId: "req-write" }) });
    expect(send).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
  });

  it.each(["--if-match", "--timeout"])("rejects a missing %s value without sending", async (flag) => {
    await expect(execute([flag])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("API asynchronous execution through the merged poller", () => {
  it.each([201, 202])("polls Azure-AsyncOperation on %s and preserves the write's IDs in the log", async (status) => {
    send.mockResolvedValueOnce(response({}, status, { "azure-asyncoperation": OPERATION, location: "https://management.azure.com/unused?api-version=1" }))
      .mockResolvedValueOnce(response({ status: "Succeeded" }));
    expect(await execute()).toMatchObject({ result: "done", status });
    expect(send.mock.calls[2]?.[1].path).toBe(OPERATION);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ httpStatus: status, outcome: "success", requestId: "req-write" }));
  });

  it("polls Location until it stops returning 202", async () => {
    send.mockResolvedValueOnce(response({}, 202, { location: OPERATION }))
      .mockResolvedValueOnce(response({}, 202, { "retry-after": "0" })).mockResolvedValueOnce(response({}, 204));
    expect(await execute()).toMatchObject({ result: "done" });
    expect(send).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledOnce();
  });

  it.each(["Failed", "Canceled"])("reports and logs an LRO %s outcome", async (status) => {
    send.mockResolvedValueOnce(response({}, 202, { "azure-asyncoperation": OPERATION }))
      .mockResolvedValueOnce(response({ status, error: { code: "SyntheticFailure", message: "test failure" } }));
    await expect(execute()).rejects.toMatchObject({ code: "OPERATION_FAILED", suggestions: expect.arrayContaining(["test failure"]) });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "OPERATION_FAILED", httpStatus: 202 }));
  });

  it("reports timeout with a resume command and logs the accepted write", async () => {
    vi.useFakeTimers();
    send.mockResolvedValueOnce(response({}, 202, { location: OPERATION, "retry-after": "10" }));
    const pending = expect(execute(["--timeout", "1"])).rejects.toMatchObject({
      code: "OPERATION_TIMEOUT", suggestions: expect.arrayContaining([expect.stringContaining("az-axi op status")]),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(send).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "OPERATION_TIMEOUT", httpStatus: 202 }));
  });

  it("returns immediately with --no-wait and no poll", async () => {
    send.mockResolvedValueOnce(response({}, 202, { "azure-asyncoperation": OPERATION }));
    expect(await execute(["--no-wait"])).toMatchObject({ result: "operation accepted", operationUrl: OPERATION,
      help: expect.arrayContaining([expect.stringContaining("az-axi op status")]) });
    expect(send).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "success", httpStatus: 202 }));
  });

  it("logs a missing operation URL as an error instead of claiming completion", async () => {
    send.mockResolvedValueOnce(response({}, 202));
    await expect(execute()).rejects.toMatchObject({ code: "API_ERROR" });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "API_ERROR" }));
  });

  it("refuses an unsafe operation URL even with --no-wait and audits the accepted write", async () => {
    send.mockResolvedValueOnce(response({}, 202, { location: "https://untrusted.example.com/operation" }));
    await expect(execute(["--no-wait"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "VALIDATION_ERROR" }));
  });
});
