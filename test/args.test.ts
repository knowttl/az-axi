import { describe, expect, it } from "vitest";
import { GLOBAL_FLAGS, assertKnownFlags, flagList, parseArgs } from "../src/lib/args.js";
import { normalizeArgv } from "../src/lib/argv.js";

function unknownFlag(argv: string[], known: string[] = []) {
  try {
    assertKnownFlags(parseArgs(argv), known, "demo");
  } catch (err) {
    return err as { code: string; message: string; suggestions: string[] };
  }
  return undefined;
}

describe("assertKnownFlags", () => {
  it("accepts every global selector flag on any command", () => {
    const argv = GLOBAL_FLAGS.flatMap((flag) => [`--${flag}`, "x"]);
    expect(unknownFlag(argv)).toBeUndefined();
    expect([...GLOBAL_FLAGS]).toEqual([
      "profile", "tenant", "subscription", "management-group", "config", "help", "full", "fields", "limit",
    ]);
  });

  it.each([
    ["sub", "subscription"],
    ["subscriptions", "subscription"],
    ["mg", "management-group"],
    ["top", "limit"],
    ["count", "limit"],
    ["max", "limit"],
    ["ws", "workspace"],
  ])("hints --%s -> --%s", (wrong, right) => {
    const error = unknownFlag([`--${wrong}`, "x"]);
    expect(error?.code).toBe("UNKNOWN_FLAG");
    expect(error?.suggestions[0]).toContain(`use --${right} instead`);
  });

  it("lists the valid flags for an unknown one and drops the ado-axi flags", () => {
    const error = unknownFlag(["--org", "x"], ["name"]);
    expect(error?.suggestions[0]).toContain("--name");
    expect(error?.suggestions[0]).toContain("--management-group");
    expect(error?.suggestions[0]).not.toContain("--project");
  });
});

describe("flagList", () => {
  it("splits comma-separated values", () => {
    expect(flagList(parseArgs(["--subscription", "a, b,,c"]), "subscription")).toEqual(["a", "b", "c"]);
  });
});

describe("normalizeArgv", () => {
  it("moves leading selector flags behind the command", () => {
    expect(normalizeArgv(["--profile", "work", "--subscription", "a,b", "sub", "list"])).toEqual([
      "sub", "list", "--profile", "work", "--subscription", "a,b",
    ]);
    expect(normalizeArgv(["--tenant=t1", "--management-group", "mg", "doctor"])).toEqual([
      "doctor", "--tenant=t1", "--management-group", "mg",
    ]);
    expect(normalizeArgv(["--config", "c.json", "config", "path"])).toEqual(["config", "path", "--config", "c.json"]);
  });

  it("hands leading flags to the home view when there is no command", () => {
    expect(normalizeArgv(["--profile", "work"])).toEqual(["home", "--profile", "work"]);
  });

  it("leaves non-selector flags and plain argv alone", () => {
    expect(normalizeArgv(["--help"])).toEqual(["--help"]);
    expect(normalizeArgv(["--org", "x", "sub", "list"])).toEqual(["--org", "x", "sub", "list"]);
    expect(normalizeArgv(["sub", "list"])).toEqual(["sub", "list"]);
  });
});
