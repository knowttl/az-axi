#!/usr/bin/env node
// Live smoke test (PLAN.md Section 13.2). Owner-run only, never in CI: it makes real read-only calls
// with whatever `az login` (or the token variables) provides.
// Prints pass or fail per check and writes the same summary to the OS temp directory.
// It never prints or stores response bodies.
//
// Usage: node scripts/live-smoke.mjs [--profile <name>] [--bin <path-to-az-axi.js>]
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const profile = option("profile");
const bin = option("bin") ?? join(root, "dist", "bin", "az-axi.js");
const selector = profile ? ["--profile", profile] : [];

function azAxi(args, env = {}) {
  const result = spawnSync(process.execPath, [bin, ...args, ...(args[0] === "--version" ? [] : selector)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

// Each check inspects the output privately and reports only a pass or fail.
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
  ["doctor: write status is disabled by default", () => {
    const r = azAxi(["doctor"]);
    return r.stdout.includes("disabled");
  }],
  ["doctor: AZ_AXI_READ_ONLY forces read-only", () => {
    const r = azAxi(["doctor"], { AZ_AXI_READ_ONLY: "1" });
    return r.stdout.includes("disabled (AZ_AXI_READ_ONLY)") && !r.stdout.includes("ENABLED");
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
    const r = azAxi(["api", "DELETE", "/subscriptions/x", "--api-version", "2022-12-01"]);
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

const results = [];
for (const [name, check] of checks) {
  let passed = false;
  try {
    passed = Boolean(check());
  } catch {
    passed = false;
  }
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
}

const out = join(tmpdir(), `az-axi-live-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
console.log(`\nsummary written to ${out}`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
