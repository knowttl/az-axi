import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendWriteLog, resolveWriteLogPath, type WriteLogInput } from "../src/lib/writeLog.js";

const SUB = "00000000-0000-0000-0000-000000000020";
const REQUEST_ID = "00000000-0000-0000-0000-000000000031";
const CORRELATION_ID = "00000000-0000-0000-0000-000000000032";
// source: Deployments - What If example shape, identifiers replaced per Section 7.3.
const URL = `https://management.azure.com/subscriptions/${SUB}/resourceGroups/contoso-rg?api-version=2022-12-01`;

const INPUT: WriteLogInput = {
  time: "2026-10-02T00:00:00.000Z",
  profile: "sandbox",
  identity: "analyst@contoso.com",
  class: "write",
  method: "PATCH",
  url: URL,
  requestId: REQUEST_ID,
  correlationId: CORRELATION_ID,
  httpStatus: 200,
  outcome: "success",
};

const LISTED_FIELDS = [
  "correlationId",
  "class",
  "httpStatus",
  "identity",
  "method",
  "outcome",
  "profile",
  "requestId",
  "time",
  "url",
].sort();

let dir: string;
const ENV_KEYS = ["AZ_AXI_WRITE_LOG", "HOME", "USERPROFILE"];
let saved: Record<string, string | undefined>;

function linesOf(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-writelog-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveWriteLogPath", () => {
  it("defaults to ~/.az-axi/writes.log", () => {
    expect(resolveWriteLogPath()).toBe(join(dir, ".az-axi", "writes.log"));
  });

  it("honours $AZ_AXI_WRITE_LOG, falling back on a blank value", () => {
    const override = join(dir, "custom.log");
    expect(resolveWriteLogPath({ AZ_AXI_WRITE_LOG: override })).toBe(override);
    expect(resolveWriteLogPath({ AZ_AXI_WRITE_LOG: "  " })).toBe(join(dir, ".az-axi", "writes.log"));
  });
});

describe("appendWriteLog", () => {
  it("writes exactly the listed fields as one JSON line, creating parents", () => {
    const file = join(dir, "nested", "writes.log");
    appendWriteLog(INPUT, file);
    const [entry] = linesOf(file) as [Record<string, unknown>];
    expect(entry).toEqual({ ...INPUT });
    expect(Object.keys(entry).sort()).toEqual(LISTED_FIELDS);
  });

  it("is append-only: later entries never disturb earlier ones", () => {
    const file = join(dir, "writes.log");
    appendWriteLog(INPUT, file);
    appendWriteLog({ ...INPUT, httpStatus: 412, outcome: "PRECONDITION_FAILED" }, file);
    const entries = linesOf(file) as [Record<string, unknown>, Record<string, unknown>];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ httpStatus: 200, outcome: "success" });
    expect(entries[1]).toMatchObject({ httpStatus: 412, outcome: "PRECONDITION_FAILED" });
  });

  it("defaults time to now and omits absent correlation IDs", () => {
    const file = join(dir, "writes.log");
    const { requestId: _dropped, correlationId: _alsoDropped, ...withoutIds } = INPUT;
    appendWriteLog(withoutIds, file);
    const [entry] = linesOf(file) as [Record<string, unknown>];
    expect(typeof entry.time).toBe("string");
    expect(Date.parse(entry.time as string)).not.toBeNaN();
    expect(entry).not.toHaveProperty("requestId");
    expect(entry).not.toHaveProperty("correlationId");
  });

  it("never writes bodies or headers, even when handed them", () => {
    const file = join(dir, "writes.log");
    appendWriteLog(
      { ...INPUT, body: { tags: { scenario: "demo" } }, headers: { authorization: "Bearer leak" } } as WriteLogInput,
      file,
    );
    const [entry] = linesOf(file) as [Record<string, unknown>];
    expect(Object.keys(entry).sort()).toEqual(LISTED_FIELDS);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("tags");
    expect(raw).not.toContain("Bearer");
  });

  it("uses the default path when no file is given", () => {
    appendWriteLog(INPUT);
    const [entry] = linesOf(join(dir, ".az-axi", "writes.log")) as [Record<string, unknown>];
    expect(entry).toMatchObject({ profile: "sandbox", outcome: "success" });
  });

  it("creates the log with user-only permissions where the OS supports it", () => {
    const file = join(dir, ".az-axi", "writes.log");
    appendWriteLog(INPUT, file);
    if (process.platform === "win32") {
      expect(readFileSync(file, "utf8")).toContain(REQUEST_ID);
    } else {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
