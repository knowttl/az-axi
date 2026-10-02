// Gate order (PLAN.md Section 6.13.2). The dry-run and execute flows that run
// after the gates pass are covered in test/dryRun.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enforceGates, subscriptionOfPath, targetResourceName } from "../src/lib/gates.js";
import type { ResolvedProfile } from "../src/lib/config.js";
import type { Resource } from "../src/lib/config.js";

const SUB = "00000000-0000-0000-0000-000000000021";
const OTHER_SUB = "00000000-0000-0000-0000-000000000022";
const SUB_PATH = `/subscriptions/${SUB}`;
const RG = `${SUB_PATH}/resourceGroups/rg-demo`;
const STORAGE = `${RG}/providers/Microsoft.Storage/storageAccounts/stdemo`;
const VM = `${RG}/providers/Microsoft.Compute/virtualMachines/vm1`;

function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return { name: "test", source: "implicit", auth: "token", writeSubscriptions: [], ...overrides };
}

function writer(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return profile({ allowWrites: true, subscriptions: [SUB], writeSubscriptions: [SUB], ...overrides });
}

function request(resource: Resource, method: string, path: string) {
  return { resource, method, path };
}

const READ_ONLY_ENV = "AZ_AXI_READ_ONLY";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[READ_ONLY_ENV];
  delete process.env[READ_ONLY_ENV];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[READ_ONLY_ENV];
  else process.env[READ_ONLY_ENV] = savedEnv;
});

describe("gate 1: AZ_AXI_READ_ONLY=1", () => {
  it("blocks even a write-enabled profile with WRITES_DISABLED", () => {
    process.env[READ_ONLY_ENV] = "1";
    try {
      enforceGates(writer(), request("arm", "PATCH", RG), "write", { execute: true });
    } catch (err) {
      expect(err).toMatchObject({ code: "WRITES_DISABLED" });
      return;
    }
    throw new Error("expected WRITES_DISABLED");
  });

  it("beats the subscription gate", () => {
    process.env[READ_ONLY_ENV] = "1";
    expect(() =>
      enforceGates(writer(), request("arm", "DELETE", `/subscriptions/${OTHER_SUB}/resourceGroups/rg-x`), "destructive"),
    ).toThrowError(expect.objectContaining({ code: "WRITES_DISABLED" }));
  });
});

describe("gate 2: profile allowWrites", () => {
  it("blocks every write and destructive request on a default profile, exactly as the stub did", () => {
    for (const [method, path, cls] of [
      ["PUT", STORAGE, "write"],
      ["PATCH", RG, "write"],
      ["POST", `${RG}/providers/Microsoft.Compute/virtualMachines/vm1/start`, "write"],
      ["DELETE", STORAGE, "destructive"],
    ] as const) {
      let error: Error & { code?: string; suggestions?: string[] };
      try {
        enforceGates(profile(), request("arm", method, path), cls);
      } catch (err) {
        error = err as typeof error;
      }
      expect(error!.code).toBe("WRITES_DISABLED");
      expect(error!.message).toBe(`blocked: writes are disabled for profile 'test' (${method} request)`);
    }
  });

  it("beats the subscription gate", () => {
    expect(() =>
      enforceGates(profile(), request("arm", "DELETE", `/subscriptions/${OTHER_SUB}/resourceGroups/rg-x`), "destructive"),
    ).toThrowError(expect.objectContaining({ code: "WRITES_DISABLED" }));
  });
});

describe("gate 3: subscription scope", () => {
  it("lets an in-scope write through to the dry run when --execute is absent", () => {
    expect(() => enforceGates(writer(), request("arm", "PATCH", RG), "write")).not.toThrow();
  });

  it("compares subscription IDs case-insensitively", () => {
    expect(() =>
      enforceGates(writer(), request("arm", "PATCH", `/subscriptions/${SUB.toUpperCase()}/resourceGroups/rg-demo`), "write"),
    ).not.toThrow();
  });

  it("blocks an out-of-scope subscription with SUBSCRIPTION_NOT_WRITABLE", () => {
    expect(() =>
      enforceGates(writer(), request("arm", "PATCH", `/subscriptions/${OTHER_SUB}/resourceGroups/rg-x`), "write"),
    ).toThrowError(expect.objectContaining({ code: "SUBSCRIPTION_NOT_WRITABLE" }));
  });

  it("always blocks paths with no subscription segment in v1", () => {
    for (const path of [
      "/providers/Microsoft.Management/managementGroups/mg-demo",
      "/providers/Microsoft.Authorization/elevateAccess",
    ]) {
      expect(() => enforceGates(writer(), request("arm", "PUT", path), "write")).toThrowError(
        expect.objectContaining({ code: "SUBSCRIPTION_NOT_WRITABLE" }),
      );
    }
  });

  it("beats the confirm gate", () => {
    expect(() =>
      enforceGates(
        writer(),
        request("arm", "DELETE", `/subscriptions/${OTHER_SUB}/resourceGroups/rg-x`),
        "destructive",
        { execute: true },
      ),
    ).toThrowError(expect.objectContaining({ code: "SUBSCRIPTION_NOT_WRITABLE" }));
  });

  it("reads the subscription from the config-file list, never an overridden scope", () => {
    const overridden = writer({ subscriptions: [OTHER_SUB] });
    expect(overridden.writeSubscriptions).toEqual([SUB]);
    expect(() => enforceGates(overridden, request("arm", "PATCH", RG), "write")).not.toThrow();
    expect(() =>
      enforceGates(overridden, request("arm", "PATCH", `/subscriptions/${OTHER_SUB}/resourceGroups/rg-x`), "write"),
    ).toThrowError(expect.objectContaining({ code: "SUBSCRIPTION_NOT_WRITABLE" }));
  });
});

describe("gate 5: destructive confirm", () => {
  it("returns the dry run for destructive requests without --execute, confirm or not", () => {
    expect(() => enforceGates(writer(), request("arm", "DELETE", STORAGE), "destructive")).not.toThrow();
    expect(() =>
      enforceGates(writer(), request("arm", "DELETE", STORAGE), "destructive", { confirm: "wrong" }),
    ).not.toThrow();
  });

  it("requires --confirm with the target name once --execute is given", () => {
    expect(() => enforceGates(writer(), request("arm", "DELETE", STORAGE), "destructive", { execute: true })).toThrowError(
      expect.objectContaining({ code: "CONFIRM_REQUIRED" }),
    );
  });

  it("rejects a mismatched --confirm", () => {
    expect(() =>
      enforceGates(writer(), request("arm", "DELETE", STORAGE), "destructive", { execute: true, confirm: "stdemo-x" }),
    ).toThrowError(expect.objectContaining({ code: "CONFIRM_MISMATCH" }));
  });

  it("matches --confirm case-sensitively against the final name segment", () => {
    expect(() =>
      enforceGates(writer(), request("arm", "DELETE", STORAGE), "destructive", { execute: true, confirm: "STDEMO" }),
    ).toThrowError(expect.objectContaining({ code: "CONFIRM_MISMATCH" }));
  });

  it("asks for the resource name, not the action, on destructive POST actions", () => {
    expect(() =>
      enforceGates(writer(), request("arm", "POST", `${VM}/restart`), "destructive", { execute: true }),
    ).toThrowError(
      expect.objectContaining({ code: "CONFIRM_REQUIRED", message: expect.stringContaining("needs --confirm 'vm1'") }),
    );
    expect(() =>
      enforceGates(writer(), request("arm", "POST", `${VM}/restart`), "destructive", {
        execute: true,
        confirm: "restart",
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFIRM_MISMATCH" }));
  });

  it("skips the confirm gate for plain writes", () => {
    expect(enforceGates(writer(), request("arm", "PATCH", RG), "write", { execute: true })).toBe(true);
  });
});

describe("gate 6: execution permission", () => {
  it("permits execution only when every gate passes with --execute", () => {
    for (const options of [{ execute: true }, { execute: true, confirm: "stdemo" }]) {
      const path = options.confirm ? STORAGE : RG;
      const cls = options.confirm ? "destructive" : "write";
      expect(enforceGates(writer(), request("arm", options.confirm ? "DELETE" : "PATCH", path), cls, options)).toBe(true);
      expect(enforceGates(writer(), request("arm", options.confirm ? "DELETE" : "PATCH", path), cls)).toBe(false);
    }
  });
});

describe("read and query requests pass through untouched", () => {
  it("never throws for read or query, whatever the profile or options", () => {
    for (const cls of ["read", "query"] as const) {
      expect(() =>
        enforceGates(profile(), request("arm", "GET", "/subscriptions"), cls, { execute: true }),
      ).not.toThrow();
    }
  });
});

describe("gate hints never explain how to enable writes", () => {
  it("keeps gates 1-3 free of enablement language", () => {
    const errors: unknown[] = [];
    const capture = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        errors.push(err);
      }
    };
    process.env[READ_ONLY_ENV] = "1";
    capture(() => enforceGates(writer(), request("arm", "PATCH", RG), "write"));
    delete process.env[READ_ONLY_ENV];
    capture(() => enforceGates(profile(), request("arm", "PATCH", RG), "write"));
    capture(() => enforceGates(writer(), request("arm", "PATCH", `/subscriptions/${OTHER_SUB}/x`), "write"));
    capture(() => enforceGates(writer(), request("arm", "PUT", "/providers/Microsoft.Management/x"), "write"));
    expect(errors).toHaveLength(4);
    for (const err of errors) {
      const text = [String((err as Error).message), ...((err as { suggestions?: string[] }).suggestions ?? [])].join("\n");
      expect(text).toContain("README.md#writes");
      expect(text).not.toMatch(/allowWrites|AZ_AXI_READ_ONLY|config file|--execute/i);
    }
  });
});

describe("path helpers", () => {
  it("reads the first subscription segment and tolerates query strings", () => {
    expect(subscriptionOfPath(`${SUB_PATH}/resourceGroups/rg-demo`)).toBe(SUB);
    expect(subscriptionOfPath(`${SUB_PATH}?api-version=2022-12-01`)).toBe(SUB);
    expect(subscriptionOfPath("/providers/Microsoft.Management/managementGroups/mg1")).toBeUndefined();
  });

  it("names the confirm target", () => {
    expect(targetResourceName(STORAGE, "DELETE")).toBe("stdemo");
    expect(targetResourceName(`${STORAGE}/`, "DELETE")).toBe("stdemo");
    expect(targetResourceName(`${VM}/restart`, "POST")).toBe("vm1");
    expect(targetResourceName(`${VM}/RESTART`, "POST")).toBe("vm1");
    expect(targetResourceName(`${VM}/start`, "POST")).toBe("start");
    expect(targetResourceName(RG, "PATCH")).toBe("rg-demo");
  });
});
