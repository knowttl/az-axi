#!/usr/bin/env node
// Live smoke test (PLAN.md Section 13.2). Owner-run only, never in CI: it makes real calls
// with whatever `az login` (or the token variables) provides.
// Prints pass, fail or skip per check and writes the same summary to the OS temp directory.
// It never prints or stores response bodies.
//
// Usage: node scripts/live-smoke.mjs [--profile <name>] [--bin <path-to-az-axi.js>]
// Writes require --writes --subscription <id> --resource-group <rg> together.
// DELETE additionally requires --delete-storage-account <pre-created-throwaway-name>.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "@toon-format/toon";
import { RESOURCE_GROUPS, STORAGE_ACCOUNTS } from "../dist/lib/apiVersions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function writeOptions(argv) {
  if (!argv.some((arg) => /^--writes(?:=|$)/.test(arg))) return undefined;
  if (argv.filter((arg) => arg === "--writes").length !== 1 || argv.some((arg) => arg.startsWith("--writes="))) {
    throw new Error("Write checks require the explicit --writes flag");
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--writes") continue;
    if (!["--profile", "--bin", "--subscription", "--resource-group", "--delete-storage-account"].includes(flag) ||
        !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error("Write checks accept only --profile, --bin, --writes, --subscription, --resource-group and --delete-storage-account");
    }
    index++;
  }
  const values = {};
  for (const name of ["profile", "bin", "subscription", "resource-group", "delete-storage-account"]) {
    const flag = `--${name}`;
    const count = argv.filter((arg) => arg === flag).length;
    const value = option(argv, name);
    if (count > 1 || argv.some((arg) => arg.startsWith(`${flag}=`)) ||
        (count === 1 && (!value || value.startsWith("--")))) {
      throw new Error(`Write checks require one explicit ${flag} value`);
    }
    values[name] = value;
  }
  if (!values.subscription || !values["resource-group"]) {
    throw new Error("Write checks require --writes --subscription <id> --resource-group <rg> together");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.subscription) ||
      !/^[-\w.()]{1,90}$/.test(values["resource-group"]) || values["resource-group"].endsWith(".")) {
    throw new Error("Write checks require one subscription GUID and one resource-group name");
  }
  if (values["delete-storage-account"] !== undefined && !/^[a-z0-9]{3,24}$/.test(values["delete-storage-account"])) {
    throw new Error("The throwaway storage account name must be 3-24 lowercase letters or digits");
  }
  return values;
}

// The injected CLI runner lets offline tests exercise the exact owner command sequence.
export function writeChecks(options, azAxi) {
  if (!options) return [];
  const rg = `/subscriptions/${options.subscription}/resourceGroups/${encodeURIComponent(options["resource-group"])}`;
  const account = options["delete-storage-account"];
  let tagPassed = false;
  let etagChecks = 0;
  let ifMatchAvailable = 0;
  let ifMatchExercised = 0;
  const api = (method, path, version, extra = [], env = {}) => {
    const r = azAxi(["api", method, path, "--api-version", version, ...extra], env);
    return { exit: r.status, output: decode(r.stdout) };
  };
  const success = (r, result) => r.exit === 0 && r.output.result === result;
  const blocked = (r, code) => r.exit === (code === "PRECONDITION_FAILED" ? 1 : 2) && r.output.code === code;

  function tagsRoundTrip(path, version, requireEtag = false) {
    const current = api("GET", path, version, ["--full"]);
    if (current.exit !== 0 || typeof current.output.id !== "string" || current.output.id.toLowerCase() !== path.toLowerCase()) return false;
    const tags = current.output.tags ?? {};
    if (typeof tags !== "object" || Array.isArray(tags) || tags === null ||
        Object.values(tags).some((value) => typeof value !== "string" || value === "***redacted***")) return false;
    // PATCH replaces tags. Carry every existing tag forward and always change the test tag.
    const body = ["--body", JSON.stringify({ tags: { ...tags, "axi-test": tags["axi-test"] === "1" ? "2" : "1" } })];
    const preview = api("PATCH", path, version, body);
    if (preview.exit !== 0 || preview.output.dryRun !== true || preview.output.noop === true ||
        !Array.isArray(preview.output.changes) || preview.output.changes.length === 0) return false;
    const etag = typeof preview.output.etag === "string" && preview.output.etag.trim() && preview.output.etag !== "*"
      ? preview.output.etag : undefined;
    etagChecks++;
    if (etag) ifMatchAvailable++;
    if (requireEtag && !etag) return "skip";
    if (!blocked(api("PATCH", path, version, [...body, "--execute"], { AZ_AXI_READ_ONLY: "1" }), "WRITES_DISABLED")) return false;
    const executed = api("PATCH", path, version, [...body, "--execute", ...(etag ? ["--if-match", etag] : [])]);
    if (!success(executed, "done") || (!etag && executed.output.protection !== "review-to-execute protection was not used")) return false;
    if (!success(api("PATCH", path, version, [...body, "--execute"]), "already in desired state (no-op)")) return false;
    if (etag) {
      // The successful PATCH changed the target after review. Reverting with its old ETag must fail.
      const stale = api("PATCH", path, version, ["--body", JSON.stringify({ tags }), "--execute", "--if-match", etag]);
      if (!blocked(stale, "PRECONDITION_FAILED")) return false;
      ifMatchExercised++;
    }
    return true;
  }

  return [
    ["writes: resource-group tag dry run, execute, no-op and read-only block", () => {
      tagPassed = tagsRoundTrip(rg, RESOURCE_GROUPS) === true;
      return tagPassed;
    }],
    ["writes: destructive throwaway storage account", () => {
      if (!account) return "Destructive step skipped: no --delete-storage-account was passed";
      if (!tagPassed) return false;
      const path = `${rg}/providers/Microsoft.Storage/storageAccounts/${account}`;
      // GET and id comparison inside tagsRoundTrip confirm this exact pre-created target exists.
      const roundTrip = tagsRoundTrip(path, STORAGE_ACCOUNTS, true);
      if (roundTrip === false) return false;
      const preview = api("DELETE", path, STORAGE_ACCOUNTS);
      if (preview.exit !== 0 || preview.output.dryRun !== true || preview.output.summary?.name !== account ||
          preview.output.lockWarning || (preview.output.help ?? []).some((hint) => hint.includes("Could not check"))) return false;
      if (!blocked(api("DELETE", path, STORAGE_ACCOUNTS, ["--execute"]), "CONFIRM_REQUIRED")) return false;
      const extra = ["--execute", "--confirm", account];
      const etag = preview.output.etag;
      if (typeof etag === "string" && etag.trim() && etag !== "*") extra.push("--if-match", etag);
      if (!success(api("DELETE", path, STORAGE_ACCOUNTS, extra), "done")) return false;
      return blocked(api("GET", path, STORAGE_ACCOUNTS), "NOT_FOUND");
    }],
    ["writes: If-Match / PRECONDITION_FAILED", () => {
      if (ifMatchAvailable > 0) return ifMatchExercised === ifMatchAvailable;
      return etagChecks === (account ? 2 : 1)
        ? "If-Match path not exercised: target returned no ETag" : false;
    }],
  ];
}

export function checksFor(argv, azAxi) {
  const writes = writeOptions(argv);
  const doctorWrites = (expected, env = {}) => {
    const dashboard = azAxi([]);
    if (dashboard.status !== 0) return false;
    const profile = decode(dashboard.stdout).profile;
    if (typeof profile !== "string") return false;
    const doctor = azAxi(["doctor"], env);
    if (doctor.status !== 0) return false;
    const profiles = decode(doctor.stdout).profiles;
    if (!Array.isArray(profiles)) return false;
    const row = profiles.find((row) => row.name === profile);
    return typeof row?.writes === "string" && row.writes.startsWith(expected);
  };

// Each check inspects the output privately and reports only an outcome or skip reason.
const checks = [
  ["version", () => {
    const r = azAxi(["--version"]);
    return r.status === 0 && /^\d+\.\d+\.\d+/.test(r.stdout.trim());
  }],
  ["config path", () => {
    const r = azAxi(["config", "path"]);
    return r.status === 0 && r.stdout.includes("path:");
  }],
  ["config list", () => {
    const r = azAxi(["config", "list"]);
    return r.status === 0 && (r.stdout.includes("profiles[") || r.stdout.includes("0 profiles found"));
  }],
  ["doctor: every profile ok", () => {
    const r = azAxi(["doctor"]);
    return r.status === 0 && r.stdout.includes("profiles[") && !/\b(failed|invalid)\b/.test(r.stdout);
  }],
  ["doctor: identity type reported", () => {
    const r = azAxi(["doctor"]);
    return /,(user|servicePrincipal|managedIdentity|token),/.test(r.stdout);
  }],
  [writes ? "doctor: write status is enabled for the selected profile" : "doctor: write status is disabled by default", () => {
    return doctorWrites(writes ? "ENABLED for " : "disabled (");
  }],
  ["doctor: AZ_AXI_READ_ONLY forces read-only", () => {
    return doctorWrites("disabled (AZ_AXI_READ_ONLY)", { AZ_AXI_READ_ONLY: "1" });
  }],
  ["sub list: ARM reachable and lists subscriptions", () => {
    const r = azAxi(["sub", "list"]);
    return r.status === 0 && /subscriptions|0 subscriptions found/.test(r.stdout);
  }],
  ["sub list --limit 1 caps rows", () => {
    const r = azAxi(["sub", "list", "--limit", "1"]);
    return r.status === 0 && Number(/subscriptions\[(\d+)\]/.exec(r.stdout)?.[1] ?? "0") <= 1;
  }],
  ["dashboard: profile, identity and write status", () => {
    const r = azAxi([]);
    return r.status === 0 && r.stdout.includes("profile:") && r.stdout.includes("writes:");
  }],
  ["rg query: Resource Graph reachable", () => {
    const r = azAxi(["rg", "query", "Resources | summarize count() by type | top 10 by count_"]);
    return r.status === 0 && (/rows\[|0 resources found/.test(r.stdout));
  }],
  ["api: escape hatch reads subscriptions", () => {
    const r = azAxi(["api", "/subscriptions", "--api-version", "2022-12-01"]);
    return r.status === 0 && (/value\[|count:/.test(r.stdout));
  }],
  ["api: DELETE is blocked with WRITES_DISABLED", () => {
    const r = azAxi(["api", "DELETE", "/subscriptions/x", "--api-version", "2022-12-01"], writes ? { AZ_AXI_READ_ONLY: "1" } : {});
    return r.status === 2 && r.stdout.includes("WRITES_DISABLED");
  }],
  ["dashboard: Defender and exposure sections", () => {
    const r = azAxi([]);
    return r.status === 0 && r.stdout.includes("defender:") && r.stdout.includes("score:") && r.stdout.includes("exposure:");
  }],
  ["defender score: secure scores per subscription", () => {
    const r = azAxi(["defender", "score"]);
    return r.status === 0 && (/scores|0 secure scores found/.test(r.stdout));
  }],
  ["defender assessments: grouped recommendations", () => {
    const r = azAxi(["defender", "assessments", "--severity", "High"]);
    return r.status === 0 && (/recommendations|0 Defender recommendations found/.test(r.stdout));
  }],
  ["defender alerts: active alerts newest first", () => {
    const r = azAxi(["defender", "alerts", "--severity", "High"]);
    return r.status === 0 && (/alerts|0 Defender alerts found/.test(r.stdout));
  }],
  ["exposure: per-check counts and sample rows", () => {
    const r = azAxi(["exposure"]);
    return r.status === 0 && r.stdout.includes("exposures");
  }],
  ["exposure --show-query prints KQL without network", () => {
    const r = azAxi(["exposure", "--show-query", "--check", "mgmt-ports"]);
    return r.status === 0 && r.stdout.includes("networksecuritygroups");
  }],
  ["unknown flag exits 2 with a rename hint", () => {
    const r = azAxi(["sub", "list", "--top", "5"]);
    return r.status === 2 && r.stdout.includes("use --limit instead");
  }],
];
  return [...checks, ...writeChecks(writes, azAxi)];
}

function main() {
  const argv = process.argv.slice(2);
  // Validate the opt-in before spawning even the first read-only check.
  try {
    writeOptions(argv);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const profile = option(argv, "profile");
  const bin = option(argv, "bin") ?? join(root, "dist", "bin", "az-axi.js");
  const selector = profile ? ["--profile", profile] : [];
  const azAxi = (args, env = {}) => {
    const result = spawnSync(process.execPath, [bin, ...args, ...(args[0] === "--version" ? [] : selector)], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    return { status: result.status, stdout: result.stdout ?? "" };
  };
  const results = [];
  for (const [name, check] of checksFor(argv, azAxi)) {
    let passed = false;
    let skipped;
    try {
      const result = check();
      skipped = typeof result === "string" ? result : undefined;
      passed = skipped !== undefined || Boolean(result);
    } catch {
      passed = false;
    }
    results.push({ name, passed, ...(skipped ? { skipped } : {}) });
    console.log(`${skipped ? "SKIP" : passed ? "PASS" : "FAIL"}  ${skipped ?? name}`);
  }
  const out = join(tmpdir(), `az-axi-live-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`\nsummary written to ${out}`);
  process.exit(results.every((r) => r.passed) ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
