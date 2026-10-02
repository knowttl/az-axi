import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configPath,
  loadConfig,
  resolveProfile,
  validateProfile,
  writeStatus,
  type ConfigFile,
} from "../src/lib/config.js";

const SUB_A = "00000000-0000-0000-0000-000000000020";
const SUB_B = "00000000-0000-0000-0000-000000000021";
const TENANT = "00000000-0000-0000-0000-000000000001";

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_TENANT", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_READ_ONLY", "HOME", "USERPROFILE"];
let saved: Record<string, string | undefined>;

function writeConfig(config: unknown, name = "config.json"): string {
  const path = join(dir, name);
  writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-config-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

const WORK: ConfigFile = {
  defaultProfile: "work",
  profiles: {
    work: { auth: "az", tenant: TENANT, managementGroup: "contoso-root", subscriptions: [] },
    sandbox: { auth: "az", subscriptions: [SUB_A], allowWrites: true },
    ci: { auth: "token", tokenEnv: { arm: "CI_ARM" } },
  },
};

describe("configPath", () => {
  it("resolves --config, then $AZ_AXI_CONFIG, then ./az-axi.config.json, then the home config", () => {
    const explicit = join(dir, "explicit.json");
    const fromEnv = join(dir, "env.json");
    process.env.AZ_AXI_CONFIG = fromEnv;
    expect(configPath(explicit)).toBe(explicit);
    expect(configPath()).toBe(fromEnv);

    delete process.env.AZ_AXI_CONFIG;
    expect(configPath()).toBe(join(dir, ".az-axi", "config.json"));

    const local = writeConfig({ profiles: {} }, "az-axi.config.json");
    expect(configPath()).toBe(local);
  });
});

describe("loadConfig", () => {
  it("returns no config when the file is absent", () => {
    expect(loadConfig(join(dir, "missing.json")).config).toBeUndefined();
  });

  it("rejects invalid JSON and a missing profiles object", () => {
    expect(() => loadConfig(writeConfig("{nope"))).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() => loadConfig(writeConfig({ defaultProfile: "x" }))).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });
});

describe("resolveProfile", () => {
  it("falls back to an implicit az profile when there is no config", () => {
    const profile = resolveProfile({ config: join(dir, "missing.json") });
    expect(profile).toMatchObject({ name: "az", auth: "az", source: "implicit", writeSubscriptions: [] });
    expect(writeStatus(profile.allowWrites, profile.writeSubscriptions).label).toBe("disabled (default)");
  });

  it("applies --tenant and $AZ_AXI_TENANT to the implicit profile", () => {
    const config = join(dir, "missing.json");
    expect(resolveProfile({ config, tenant: "t-flag" }).tenant).toBe("t-flag");
    process.env.AZ_AXI_TENANT = "t-env";
    expect(resolveProfile({ config }).tenant).toBe("t-env");
    expect(resolveProfile({ config, tenant: "t-flag" }).tenant).toBe("t-flag");
  });

  it("prefers --profile, then $AZ_AXI_PROFILE, then defaultProfile", () => {
    const config = writeConfig(WORK);
    expect(resolveProfile({ config }).name).toBe("work");
    process.env.AZ_AXI_PROFILE = "ci";
    expect(resolveProfile({ config }).name).toBe("ci");
    expect(resolveProfile({ config, profile: "sandbox" })).toMatchObject({ name: "sandbox", source: "flag" });
  });

  it("uses the only profile when there is no default and demands a choice among several", () => {
    expect(resolveProfile({ config: writeConfig({ profiles: { solo: { auth: "az" } } }) }).name).toBe("solo");
    expect(() => resolveProfile({ config: writeConfig({ profiles: WORK.profiles }) })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  it("rejects an unknown profile and a dangling defaultProfile", () => {
    const config = writeConfig(WORK);
    expect(() => resolveProfile({ config, profile: "nope" })).toThrowError(/not found/);
    expect(() => resolveProfile({ config: writeConfig({ defaultProfile: "gone", profiles: { a: { auth: "az" } } }) })).toThrowError(
      /defaultProfile 'gone'/,
    );
  });

  it("lets flags, then env, override the read scope", () => {
    const config = writeConfig(WORK);
    process.env.AZ_AXI_SUBSCRIPTION = `${SUB_A},${SUB_B}`;
    process.env.AZ_AXI_TENANT = "t-env";
    expect(resolveProfile({ config })).toMatchObject({ subscriptions: [SUB_A, SUB_B], tenant: "t-env" });
    expect(resolveProfile({ config, subscriptions: [SUB_B], tenant: "t-flag", managementGroup: "mg2" })).toMatchObject({
      subscriptions: [SUB_B],
      tenant: "t-flag",
      managementGroup: "mg2",
    });
  });

  it("never widens the writable subscriptions through a flag or env override", () => {
    const config = writeConfig(WORK);
    process.env.AZ_AXI_SUBSCRIPTION = SUB_B;
    const viaEnv = resolveProfile({ config, profile: "sandbox" });
    expect(viaEnv.subscriptions).toEqual([SUB_B]);
    expect(viaEnv.writeSubscriptions).toEqual([SUB_A]);
    const viaFlag = resolveProfile({ config, profile: "sandbox", subscriptions: [SUB_B] });
    expect(viaFlag.writeSubscriptions).toEqual([SUB_A]);
  });
});

describe("allowWrites rules", () => {
  it("rejects allowWrites without a subscriptions list", () => {
    for (const profile of [{ auth: "az", allowWrites: true }, { auth: "az", allowWrites: true, subscriptions: [] }]) {
      expect(() => resolveProfile({ config: writeConfig({ profiles: { bad: profile } }) })).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR", message: expect.stringContaining("subscriptions") }),
      );
    }
  });

  it("rejects non-boolean allowWrites, bad auth and bad subscriptions", () => {
    expect(() => validateProfile("p", { auth: "az", allowWrites: "true" as unknown as boolean })).toThrowError(/allowWrites/);
    expect(() => validateProfile("p", { auth: "pat" as unknown as "az" })).toThrowError(/auth/);
    expect(() => validateProfile("p", { auth: "az", subscriptions: "x" as unknown as string[] })).toThrowError(/subscriptions/);
  });

  it("defaults to disabled and reports ENABLED only for a valid write profile", () => {
    expect(writeStatus(undefined, []).label).toBe("disabled (default)");
    expect(writeStatus(false, [SUB_A]).label).toBe("disabled (default)");
    expect(writeStatus(true, [SUB_A]).label).toBe("ENABLED for 1 subscription");
    expect(writeStatus(true, [SUB_A, SUB_B])).toEqual({ enabled: true, label: "ENABLED for 2 subscriptions" });
    expect(writeStatus(true, []).enabled).toBe(false);
  });

  it.each(["1", "true", "TRUE"])("$AZ_AXI_READ_ONLY=%s forces read-only over a write-enabled profile", (value) => {
    process.env.AZ_AXI_READ_ONLY = value;
    expect(writeStatus(true, [SUB_A])).toEqual({ enabled: false, label: "disabled (AZ_AXI_READ_ONLY)" });
  });

  it.each(["0", "", "no"])("$AZ_AXI_READ_ONLY=%j does not force read-only", (value) => {
    process.env.AZ_AXI_READ_ONLY = value;
    expect(writeStatus(true, [SUB_A]).enabled).toBe(true);
  });
});
