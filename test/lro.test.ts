// Long-running operations and `op status` (PLAN.md Sections 6.13.5, 8).
// The client is mocked; polling delays run on fake timers or an injected clock.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn() }));

import { run } from "../src/commands/op.js";
import { sendRequest } from "../src/lib/client.js";
import type { ResolvedProfile } from "../src/lib/config.js";
import { saveConfig } from "../src/lib/config.js";
import {
  DEFAULT_TIMEOUT_MS,
  assertOperationUrl,
  describeOperation,
  operationUrls,
  opStatusCommand,
  parseTimeoutFlag,
  pollOperation,
} from "../src/lib/lro.js";

const sendMock = vi.mocked(sendRequest);

const OP_URL =
  "https://management.azure.com/providers/Microsoft.Resources/operationResults/abc?api-version=2022-12-01";
const LOCATION_URL =
  "https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000020/resourceGroups/rg-demo?api-version=2021-04-01";

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

function profile(): ResolvedProfile {
  return { name: "test", source: "implicit", auth: "token", writeSubscriptions: [] };
}

const resp = (body: unknown, extra: Record<string, unknown> = {}) => ({
  status: 200,
  headers: {},
  body,
  clientRequestId: "req-1",
  ...extra,
});
const asyncOp = (status: string, error?: unknown) => resp(error ? { status, error } : { status });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-lro-"));
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
  vi.useRealTimers();
});

describe("assertOperationUrl", () => {
  it("accepts an absolute https URL on management.azure.com", () => {
    expect(assertOperationUrl(OP_URL)).toBe(OP_URL);
  });

  it.each([
    "https://graph.microsoft.com/v1.0/directoryObjects/getByIds",
    "https://api.loganalytics.io/v1/workspaces/abc/query",
    "https://example.com/ops/1",
    "http://management.azure.com/ops/1",
    "/subscriptions/abc/operationResults/1",
    "not-a-url",
  ])("rejects '%s' with VALIDATION_ERROR", (value) => {
    expect(() => assertOperationUrl(value)).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });
});

describe("parseTimeoutFlag", () => {
  it("defaults to 600s", () => {
    expect(parseTimeoutFlag(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
  });

  it.each([
    ["600", 600_000],
    ["60", 60_000],
    ["0.5", 500],
  ])("parses '%s' to %sms", (flag, ms) => {
    expect(parseTimeoutFlag(flag)).toBe(ms);
  });

  it.each(["0", "-5", "ten", "1h", "60s", "10m", "Infinity", "1e309", ""])("rejects '%s' with VALIDATION_ERROR", (flag) => {
    expect(() => parseTimeoutFlag(flag)).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });
});

describe("describeOperation", () => {
  it("reads the Azure-AsyncOperation status", () => {
    expect(describeOperation(asyncOp("InProgress"))).toMatchObject({ state: "InProgress", running: true, failed: false });
    expect(describeOperation(asyncOp("Succeeded"))).toMatchObject({ state: "Succeeded", running: false, failed: false });
  });

  it("reports Failed and Canceled with the operation error", () => {
    const failed = describeOperation(
      asyncOp("Failed", { code: "DeploymentFailed", message: "template validation failed" }),
    );
    expect(failed).toMatchObject({
      running: false,
      failed: true,
      code: "DeploymentFailed",
      message: "template validation failed",
    });
    expect(describeOperation(asyncOp("Canceled"))).toMatchObject({ running: false, failed: true });
  });

  it("treats a 202 without a status as running and any other as done", () => {
    expect(describeOperation(resp({ value: [] }, { status: 202 }))).toMatchObject({
      state: "InProgress",
      running: true,
    });
    expect(describeOperation(resp({ name: "rg-demo" }))).toMatchObject({ state: "Succeeded", running: false });
  });
});

describe("operationUrls", () => {
  it("reads the async headers using the client's lower-cased names", () => {
    expect(operationUrls(resp({}, { headers: { "azure-asyncoperation": OP_URL, location: LOCATION_URL } }))).toEqual({
      asyncOperationUrl: OP_URL,
      locationUrl: LOCATION_URL,
    });
    expect(operationUrls(resp({}))).toEqual({});
  });
});

describe("pollOperation", () => {
  it.each([
    ["azure-asyncoperation", "17"],
    ["location", "17"],
    ["azure-asyncoperation", "Thu, 01 Jan 1970 00:00:17 GMT"],
    ["location", "Thu, 01 Jan 1970 00:00:17 GMT"],
  ])("honours the initial %s response's Retry-After %s", async (header, retryAfter) => {
    let clock = 0;
    sendMock.mockImplementation(async () => {
      expect(clock).toBe(17_000);
      return asyncOp("Succeeded");
    });
    const urls = operationUrls(resp({}, { headers: { [header]: OP_URL, "retry-after": retryAfter } }));
    await pollOperation(profile(), urls, { now: () => clock, delay: async (ms) => { clock += ms; } });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it.each(["asyncOperationUrl", "locationUrl"])("bounds initial and repeat waits for %s", async (key) => {
    for (const initial of [false, true]) {
      sendMock.mockReset();
      let clock = 0;
      sendMock
        .mockResolvedValueOnce(resp({ status: "InProgress" }, { headers: { "retry-after": "60" } }))
        .mockResolvedValueOnce(asyncOp("Succeeded"));
      await expect(pollOperation(profile(), { [key]: OP_URL, ...(initial ? { retryAfter: "60" } : {}) }, {
        timeoutMs: 25_000,
        now: () => clock,
        delay: async (ms) => { clock += ms; },
      })).rejects.toMatchObject({ code: "OPERATION_TIMEOUT" });
      expect(clock).toBe(25_000);
      expect(sendMock).toHaveBeenCalledTimes(initial ? 0 : 1);
    }
  });

  it.each(["asyncOperationUrl", "locationUrl"])("rejects late success for %s", async (key) => {
    let clock = 0;
    sendMock.mockImplementation(async () => {
      clock = 25_000;
      return asyncOp("Succeeded");
    });
    await expect(pollOperation(profile(), { [key]: OP_URL }, { timeoutMs: 25_000, now: () => clock }))
      .rejects.toMatchObject({ code: "OPERATION_TIMEOUT" });
  });

  it("bounds a pending request and aborts it with a contextual resume command", async () => {
    vi.useFakeTimers();
    sendMock.mockImplementation(() => new Promise(() => {}));
    const selected = { ...profile(), configPath: "/work/team.json", name: "work", tenant: "T" };
    const pending = pollOperation(selected, { asyncOperationUrl: OP_URL }, { timeoutMs: 25_000 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "OPERATION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
    expect(sendMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    const error = await pending.catch((err) => err);
    expect(error.suggestions).toContain(`Resume with \`${opStatusCommand(OP_URL, selected)}\``);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prefers the Azure-AsyncOperation URL and returns the terminal response", async () => {
    sendMock.mockResolvedValueOnce(asyncOp("InProgress")).mockResolvedValueOnce(asyncOp("Succeeded"));
    const delays: number[] = [];
    const done = await pollOperation(
      profile(),
      { asyncOperationUrl: OP_URL, locationUrl: LOCATION_URL },
      { delay: async (ms) => { delays.push(ms); } },
    );
    expect(done.body).toEqual({ status: "Succeeded" });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0]?.[1]).toEqual({ path: OP_URL, signal: expect.any(AbortSignal) });
    expect(delays).toEqual([10_000]);
  });

  it("honours Retry-After, defaulting to 10s", async () => {
    sendMock
      .mockResolvedValueOnce(resp({ status: "InProgress" }, { headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(asyncOp("Succeeded"));
    const delays: number[] = [];
    await pollOperation(profile(), { asyncOperationUrl: OP_URL }, { delay: async (ms) => { delays.push(ms); } });
    expect(delays).toEqual([2_000]);
  });

  it("polls Location until it stops returning 202", async () => {
    sendMock
      .mockResolvedValueOnce(resp(undefined, { status: 202 }))
      .mockResolvedValueOnce(resp({ name: "rg-demo" }));
    const delays: number[] = [];
    const done = await pollOperation(
      profile(),
      { locationUrl: LOCATION_URL },
      { delay: async (ms) => { delays.push(ms); } },
    );
    expect(done.body).toEqual({ name: "rg-demo" });
    expect(sendMock.mock.calls[0]?.[1]).toEqual({ path: LOCATION_URL, signal: expect.any(AbortSignal) });
    expect(delays).toEqual([10_000]);
  });

  it("maps Failed and Canceled to OPERATION_FAILED with the operation error", async () => {
    sendMock.mockResolvedValue(asyncOp("Failed", { code: "DeploymentFailed", message: "template validation failed" }));
    const failed = await pollOperation(profile(), { asyncOperationUrl: OP_URL }).catch((err) => err);
    expect(failed).toMatchObject({ code: "OPERATION_FAILED" });
    expect(failed.message).toContain("DeploymentFailed");
    expect(failed.suggestions.join("\n")).toContain("template validation failed");

    sendMock.mockReset();
    sendMock.mockResolvedValue(asyncOp("Canceled"));
    await expect(pollOperation(profile(), { asyncOperationUrl: OP_URL })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
    });
  });

  it("times out with OPERATION_TIMEOUT and the op status resume command", async () => {
    vi.useFakeTimers();
    try {
      sendMock.mockResolvedValue(asyncOp("InProgress"));
      const pending = pollOperation(profile(), { asyncOperationUrl: OP_URL }, { timeoutMs: 25_000 });
      const assertion = expect(pending).rejects.toMatchObject({ code: "OPERATION_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(60_000);
      const error = await pending.catch((err) => err);
      expect(error.message).toContain("25s");
      expect(error.suggestions).toContain(`Resume with \`az-axi op status '${OP_URL}'\``);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to poll without an operation URL, or off the ARM host", async () => {
    await expect(pollOperation(profile(), {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      pollOperation(profile(), { asyncOperationUrl: "https://graph.microsoft.com/v1.0/ops/1" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("op status", () => {
  it("retains the selected config, profile and tenant when its hint is executed", async () => {
    const config = saveConfig({ profiles: { work: { auth: "token", tenant: "original" } } }, join(dir, "work.json"));
    sendMock.mockResolvedValue(asyncOp("InProgress"));
    const result = await run(["status", OP_URL, "--config", config, "--profile", "work", "--tenant", "T"]);
    const hint = (result.help as string[])[0] as string;
    const command = hint.slice(hint.indexOf("`") + 1, hint.lastIndexOf("`"));
    const argv = JSON.parse(execFileSync("bash", ["-c", `az-axi() { node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"; }; ${command}`], { encoding: "utf8" })) as string[];
    expect(argv).toEqual(["op", "status", OP_URL, "--config", config, "--profile", "work", "--tenant", "T"]);
    await run(argv.slice(1));
    expect(sendMock.mock.calls[1]?.[0]).toMatchObject({ configPath: config, name: "work", tenant: "T", auth: "token" });
  });

  it("preserves authentication selectors and shell arguments in recheck commands", async () => {
    sendMock.mockResolvedValue(asyncOp("InProgress"));
    const selected = { ...profile(), configPath: "/work/team's config.json", name: "work's", tenant: "T $(false)" };
    const url = `${OP_URL}&monitor=true`;
    const command = opStatusCommand(url, selected);
    const argumentsJson = execFileSync("bash", ["-c", `az-axi() { node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"; }; ${command}`], { encoding: "utf8" });
    const argv = JSON.parse(argumentsJson) as string[];
    expect(argv).toEqual(["op", "status", url, "--config", selected.configPath, "--profile", selected.name, "--tenant", selected.tenant]);
    const result = await run(["status", url, "--tenant", selected.tenant]);
    expect(result.help).toEqual([`Re-run \`az-axi op status '${url}' --tenant 'T $(false)'\` to check again`]);
  });

  it("GETs the operation URL and reports its state", async () => {
    sendMock.mockResolvedValue(asyncOp("Succeeded"));
    const result = await run(["status", OP_URL]);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ name: "az" }), { path: OP_URL });
    expect(result).toMatchObject({ operation: OP_URL, state: "Succeeded", status: 200 });
    expect(result.help).toBeUndefined();
  });

  it("hints the re-run command while the operation is still going", async () => {
    sendMock.mockResolvedValue(asyncOp("InProgress"));
    const result = await run(["status", OP_URL]);
    expect(result).toMatchObject({ state: "InProgress" });
    expect(result.help).toEqual([`Re-run \`az-axi op status '${OP_URL}'\` to check again`]);
  });

  it("reports a failed operation with its code and message instead of throwing", async () => {
    sendMock.mockResolvedValue(asyncOp("Failed", { code: "DeploymentFailed", message: "template validation failed" }));
    const result = await run(["status", OP_URL]);
    expect(result).toMatchObject({
      state: "Failed",
      code: "DeploymentFailed",
      error: "template validation failed",
    });
  });

  it("rejects any host other than management.azure.com without sending anything", async () => {
    await expect(run(["status", "https://graph.microsoft.com/v1.0/ops/1"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("requires exactly one operation URL", async () => {
    await expect(run(["status"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["status", OP_URL, "extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["other", OP_URL])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
