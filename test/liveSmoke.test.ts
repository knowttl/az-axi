import { encode } from "@toon-format/toon";
import { describe, expect, it, vi } from "vitest";
// Importing exposes checks only. No subprocess, live call or summary file is created.
import { checksFor, writeChecks, writeOptions } from "../scripts/live-smoke.mjs";

const SUB = "00000000-0000-0000-0000-000000000020";
const RG = `/subscriptions/${SUB}/resourceGroups/rg-demo`;
const ACCOUNT = `${RG}/providers/Microsoft.Storage/storageAccounts/throwaway123`;
const FLAGS = ["--writes", "--subscription", SUB, "--resource-group", "rg-demo"];
const DELETE_FLAGS = [...FLAGS, "--delete-storage-account", "throwaway123"];
const response = (output: unknown, status = 0) => ({ status, stdout: encode(output) });

// Shapes follow ResourceGroup and StorageAccount spec examples, with synthetic IDs.
function runner(etag: boolean | "account" = false) {
  const states = new Map<string, { tags: Record<string, string>; changed: boolean }>();
  for (const path of [RG, ACCOUNT]) states.set(path, { tags: { existing: "keep" }, changed: false });
  return vi.fn((argv: string[], env: Record<string, string> = {}) => {
    const [, method, path] = argv;
    const state = states.get(path!);
    if (env.AZ_AXI_READ_ONLY === "1") return response({ code: "WRITES_DISABLED" }, 2);
    if (method === "GET") return state ? response({ status: 200, id: path, tags: state.tags }) : response({ code: "NOT_FOUND" }, 2);
    if (!argv.includes("--execute")) return response({ dryRun: true, changes: [{ path: "tags.axi-test", to: "1" }],
      ...(method === "DELETE" ? { summary: { name: "throwaway123" } } : {}),
      ...(etag === true || (etag === "account" && path === ACCOUNT) ? { etag: state?.changed ? '"after"' : '"before"' } : {}) });
    if (method === "DELETE") {
      if (!argv.includes("--confirm")) return response({ code: "CONFIRM_REQUIRED" }, 2);
      states.delete(path!);
      return response({ result: "done" });
    }
    const tags = JSON.parse(argv[argv.indexOf("--body") + 1]!).tags;
    if (JSON.stringify(tags) === JSON.stringify(state!.tags)) return response({ result: "already in desired state (no-op)" });
    if (state!.changed && argv.includes("--if-match") && argv[argv.indexOf("--if-match") + 1] === '"before"') {
      return response({ code: "PRECONDITION_FAILED" }, 1);
    }
    state!.tags = tags;
    state!.changed = true;
    return response({ result: "done", ...(!argv.includes("--if-match") ? { protection: "review-to-execute protection was not used" } : {}) });
  });
}

function execute(argv: string[], client: ReturnType<typeof runner>) {
  return writeChecks(writeOptions(argv), client).map(([name, check]: [string, () => boolean | string]) => ({ name, result: check() }));
}

describe("owner smoke checks, mocked CLI only", () => {
  it.each([[], ["--subscription", SUB, "--resource-group", "rg-demo"], ["--delete-storage-account", "throwaway123"]].map((argv) => ({ argv })))("never adds write checks without literal --writes: $argv", ({ argv }) => {
    const client = runner();
    expect(execute(argv, client)).toEqual([]);
    expect(client).not.toHaveBeenCalled();
    expect(checksFor(argv, client)).toHaveLength(20);
  });

  it.each([
    ["--writes"], ["--writes", "--subscription", SUB], ["--writes", "--resource-group", "rg-demo"],
    ["--writes", "--subscription", "--resource-group", "rg-demo"],
    [...FLAGS, "--subscription", SUB], [...FLAGS, "--writes"], [...FLAGS, "--writes=false"],
    ["--writes=true", "--subscription", SUB, "--resource-group", "rg-demo"],
    ["--writes", `--subscription=${SUB}`, "--resource-group", "rg-demo"],
    ["--writes", "--subscription", `${SUB},${SUB}`, "--resource-group", "rg-demo"],
    [...FLAGS.slice(0, -1), "../other"], [...FLAGS, "--delete-storage-account", "../other"],
    [...FLAGS, "--dry-run"], [...FLAGS, "--profile"], [...FLAGS, "--bin", "first", "--bin", "second"],
  ].map((argv) => ({ argv })))("rejects an incomplete or ambiguous gate before any runner call: $argv", ({ argv }) => {
    const client = runner();
    expect(() => checksFor(argv, client)).toThrow();
    expect(client).not.toHaveBeenCalled();
  });

  it("runs only the tag flow without destructive opt-in, preserving tags and asserting missing protection", () => {
    const client = runner();
    const results = execute(FLAGS, client);
    expect(results.map((row) => row.result)).toEqual([true, "Destructive step skipped: no --delete-storage-account was passed", "If-Match path not exercised: target returned no ETag"]);
    const body = ["--body", '{"tags":{"existing":"keep","axi-test":"1"}}'];
    const base = ["api", "PATCH", RG, "--api-version", "2021-04-01"];
    expect(client.mock.calls).toEqual([
      [["api", "GET", RG, "--api-version", "2021-04-01", "--full"], {}],
      [[...base, ...body], {}],
      [[...base, ...body, "--execute"], { AZ_AXI_READ_ONLY: "1" }],
      [[...base, ...body, "--execute"], {}],
      [[...base, ...body, "--execute"], {}],
    ]);
  });

  it("accepts explicit profile and binary selectors without changing the write target", () => {
    expect(writeOptions([...FLAGS, "--profile", "sandbox", "--bin", "/example/bin.js"])).toMatchObject({
      subscription: SUB, "resource-group": "rg-demo", profile: "sandbox", bin: "/example/bin.js",
    });
  });

  it.each([
    { argv: FLAGS, selected: "reader", expected: false },
    { argv: FLAGS, selected: "writer", expected: true },
    { argv: [], selected: "reader", expected: true },
    { argv: [], selected: "writer", expected: false },
    { argv: [...FLAGS, "--profile", "writer"], selected: "writer", expected: true },
  ])("checks the dashboard's selected profile: $selected with $argv", ({ argv, selected, expected }) => {
    const client = vi.fn((args: string[]) => args.length === 0
      ? response({ profile: selected })
      : response({ profiles: [
        { name: "reader", writes: "disabled (default)" },
        { name: "writer", writes: "ENABLED for 1 subscription" },
      ] }));
    const check = checksFor(argv, client).find(([name]: [string]) => name.startsWith("doctor: write status"))![1];
    expect(check()).toBe(expected);
  });

  it.each(["doctor failed", "dashboard failed", "profile missing", "wrong forced profile"])("rejects write-status evidence when %s", (failure) => {
    const client = vi.fn((args: string[]) => args.length === 0
      ? response({ profile: "selected" }, failure === "dashboard failed" ? 1 : 0)
      : response({ profiles: [
        { name: "other", writes: "disabled (AZ_AXI_READ_ONLY)" },
        ...(failure === "profile missing" ? [] : [{ name: "selected", writes: failure === "wrong forced profile"
          ? "ENABLED for 1 subscription" : "disabled (AZ_AXI_READ_ONLY)" }]),
      ] }, failure === "doctor failed" ? 1 : 0));
    const check = checksFor([], client).find(([name]: [string]) => name === "doctor: AZ_AXI_READ_ONLY forces read-only")![1];
    expect(check()).toBe(false);
  });

  it("checks forced read-only on the selected profile with a successful doctor response", () => {
    const client = vi.fn((args: string[], env: Record<string, string> = {}) => args.length === 0
      ? response({ profile: "writer" })
      : response({ profiles: [{ name: "writer", writes: env.AZ_AXI_READ_ONLY === "1"
        ? "disabled (AZ_AXI_READ_ONLY)" : "ENABLED for 1 subscription" }] }));
    const check = checksFor(FLAGS, client).find(([name]: [string]) => name === "doctor: AZ_AXI_READ_ONLY forces read-only")![1];
    expect(check()).toBe(true);
    expect(client).toHaveBeenCalledWith(["doctor"], { AZ_AXI_READ_ONLY: "1" });
  });

  it.each([RG, ACCOUNT].flatMap((path) => ["read-only", "execute", "no-op", "stale"].map((stage) => ({ path, stage }))))(
    "fails If-Match verification when $stage fails for $path despite an available ETag", ({ path, stage }) => {
      const good = runner(true);
      const client = vi.fn((argv: string[], env: Record<string, string> = {}) => {
        if (argv[1] === "PATCH" && argv[2] === path && argv.includes("--execute")) {
          if (stage === "read-only" && env.AZ_AXI_READ_ONLY) return response({ result: "done" });
          if (!env.AZ_AXI_READ_ONLY) {
            if (stage === "execute" && argv.includes("--if-match")) return response({ code: "PRECONDITION_FAILED" }, 1);
            if (stage === "no-op" && !argv.includes("--if-match")) return response({ result: "done" });
            if (stage === "stale" && argv[argv.indexOf("--body") + 1] === '{"tags":{"existing":"keep"}}') return response({ result: "done" });
          }
        }
        return good(argv, env);
      });
      const results = execute(DELETE_FLAGS, client);
      expect(results[path === RG ? 0 : 1]?.result).toBe(false);
      expect(results[2]?.result).toBe(false);
    },
  );

  it.each([RG, ACCOUNT])("does not claim ETag absence when preview was never obtained for %s", (path) => {
    const good = runner();
    const client = vi.fn((argv: string[], env: Record<string, string> = {}) => argv[1] === "GET" && argv[2] === path
      ? response({ code: "NOT_FOUND" }, 2) : good(argv, env));
    expect(execute(DELETE_FLAGS, client)[2]?.result).toBe(false);
  });

  it.each(["missing", "wrong", "lock-check failed", "confirmation failed", "stale ETag accepted"])("does not delete when the account precondition is %s", (failure) => {
    const good = runner(true);
    const client = vi.fn((argv: string[], env: Record<string, string> = {}) => {
      if (argv[2] === ACCOUNT) {
        if (argv[1] === "GET" && failure === "missing") return response({ code: "NOT_FOUND" }, 2);
        if (argv[1] === "GET" && failure === "wrong") return response({ id: "/other", tags: {} });
        if (argv[1] === "DELETE" && !argv.includes("--execute") && failure === "lock-check failed") {
          return response({ dryRun: true, summary: { name: "throwaway123" }, help: ["Could not check resource locks"] });
        }
        if (argv[1] === "DELETE" && !argv.includes("--confirm") && argv.includes("--execute") && failure === "confirmation failed") {
          return response({ code: "WRITES_DISABLED" }, 2);
        }
        if (argv[1] === "PATCH" && argv.includes("--if-match") && argv[argv.indexOf("--body") + 1] === '{"tags":{"existing":"keep"}}' && failure === "stale ETag accepted") {
          return response({ result: "done" });
        }
      }
      return good(argv, env);
    });
    expect(execute(DELETE_FLAGS, client)[1]?.result).toBe(false);
    expect(client.mock.calls.some(([argv]) => argv[1] === "DELETE" && argv.includes("--confirm"))).toBe(false);
  });

  it("uses the real preview ETag, checks stale execution, and deletes only the named existing account with confirmation", () => {
    const client = runner(true);
    expect(execute(DELETE_FLAGS, client).map((row) => row.result)).toEqual([true, true, true]);
    const calls = client.mock.calls.map(([argv]) => argv);
    for (const path of [RG, ACCOUNT]) {
      const patches = calls.filter((argv) => argv[1] === "PATCH" && argv[2] === path);
      expect(patches.map((argv) => argv.slice(5))).toEqual([
        ["--body", '{"tags":{"existing":"keep","axi-test":"1"}}'],
        ["--body", '{"tags":{"existing":"keep","axi-test":"1"}}', "--execute"],
        ["--body", '{"tags":{"existing":"keep","axi-test":"1"}}', "--execute", "--if-match", '"before"'],
        ["--body", '{"tags":{"existing":"keep","axi-test":"1"}}', "--execute"],
        ["--body", '{"tags":{"existing":"keep"}}', "--execute", "--if-match", '"before"'],
      ]);
    }
    expect(calls.slice(-4)).toEqual([
      ["api", "DELETE", ACCOUNT, "--api-version", "2025-06-01"],
      ["api", "DELETE", ACCOUNT, "--api-version", "2025-06-01", "--execute"],
      ["api", "DELETE", ACCOUNT, "--api-version", "2025-06-01", "--execute", "--confirm", "throwaway123", "--if-match", '"after"'],
      ["api", "GET", ACCOUNT, "--api-version", "2025-06-01"],
    ]);
    expect(calls.some((argv) => argv[1] === "DELETE" && argv[2] === RG)).toBe(false);
  });

  it("deletes a confirmed existing account without fabricating an ETag", () => {
    const client = runner();
    expect(execute(DELETE_FLAGS, client).map((row) => row.result)).toEqual([true, true, "If-Match path not exercised: target returned no ETag"]);
    expect(client.mock.calls.some(([argv]) => argv.includes("--if-match"))).toBe(false);
    expect(client.mock.calls.filter(([argv]) => argv[1] === "PATCH" && argv[2] === ACCOUNT)).toHaveLength(1);
  });

  it("exercises If-Match on the throwaway account when the resource group has no ETag", () => {
    const client = runner("account");
    expect(execute(DELETE_FLAGS, client).map((row) => row.result)).toEqual([true, true, true]);
    const protectedCalls = client.mock.calls.filter(([argv]) => argv.includes("--if-match"));
    expect(protectedCalls).toHaveLength(3);
    expect(protectedCalls.every(([argv]) => argv[2] === ACCOUNT)).toBe(true);
  });

  it.each(["missing", "wrong target", "redacted tags", "preview failed", "read-only failed", "write failed", "not noop", "no protection", "locks"])("fails closed on %s", (failure) => {
    const good = runner();
    const client = vi.fn((argv: string[], env: Record<string, string> = {}) => {
      const result = good(argv, env);
      if (argv[1] === "GET" && argv[2] === RG && failure === "missing") return response({ code: "NOT_FOUND" }, 2);
      if (argv[1] === "GET" && failure === "wrong target") return response({ id: "/other", tags: {} });
      if (argv[1] === "GET" && failure === "redacted tags") return response({ id: RG, tags: { secret: "***redacted***" } });
      if (argv[1] === "PATCH" && !argv.includes("--execute") && failure === "preview failed") return response({ code: "WRITES_DISABLED" }, 2);
      if (env.AZ_AXI_READ_ONLY && failure === "read-only failed") return response({ result: "done" });
      if (argv[1] === "PATCH" && argv.includes("--execute") && !env.AZ_AXI_READ_ONLY) {
        if (failure === "write failed") return response({ code: "PRECONDITION_FAILED" }, 1);
        if (failure === "not noop") return response({ result: "done", protection: "review-to-execute protection was not used" });
        if (failure === "no protection") return response({ result: "done" });
      }
      if (argv[1] === "DELETE" && !argv.includes("--execute") && failure === "locks") return response({ dryRun: true, summary: { name: "throwaway123" }, lockWarning: "locked" });
      return result;
    });
    expect(execute(DELETE_FLAGS, client).some((row) => row.result === false)).toBe(true);
    expect(client.mock.calls.some(([argv]) => argv[1] === "DELETE" && argv.includes("--execute"))).toBe(false);
  });
});
