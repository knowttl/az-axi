import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scenarios } from "../../benchmark/scenarios.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (process.argv.length !== 2) throw new Error("Usage: pnpm bench:capture (owner only; see CONTRIBUTING.md#benchmarks)");
const targets: Record<string, unknown> & { profile: string; subscription: string; workspace: string; leakCheck: string[] } = JSON.parse(readFileSync(new URL("../../benchmark/targets.json", import.meta.url), "utf8"));
for (const name of ["profile", "subscription", "workspace"] as const) {
  if (typeof targets[name] !== "string" || !targets[name].trim()) throw new Error(`targets.json requires ${name}`);
}
for (const name of ["subscription", "workspace"] as const) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targets[name])) {
    throw new Error(`targets.json requires one ${name} GUID`);
  }
}
if (!Array.isArray(targets.leakCheck) || !targets.leakCheck.length ||
    targets.leakCheck.some((value: unknown) => typeof value !== "string" || !value)) {
  throw new Error("targets.json requires a nonempty leakCheck string array");
}
mkdirSync(new URL("../../benchmark/fixtures/", import.meta.url), { recursive: true });
for (const scenario of scenarios) {
  const file = fileURLToPath(new URL(`../../benchmark/fixtures/${scenario.name}.json`, import.meta.url));
  rmSync(file, { force: true });
  const argv = [...scenario.argv, "--profile", targets.profile, "--subscription", targets.subscription];
  if (scenario.ownerTarget) {
    const target = targets[scenario.ownerTarget];
    if (typeof target !== "string" || !target.trim()) {
      process.stderr.write(`Skipped ${scenario.name}: targets.json ${scenario.ownerTarget} is unset\n`);
      continue;
    }
    const flag = scenario.ownerTarget === "resourceGroup" ? "--name" : argv.includes("--resource") ? "--resource" : "--ids";
    argv[argv.indexOf(flag) + 1] = target;
  }
  const workspaceIndex = argv.indexOf("--workspace");
  if (workspaceIndex !== -1) argv[workspaceIndex + 1] = targets.workspace;
  const child = spawnSync(process.execPath, ["--import", "./scripts/benchmark/fetch-hook.ts", "dist/bin/az-axi.js", ...argv], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "", AZ_AXI_READ_ONLY: "1", AZ_AXI_BENCH_MODE: "record",
      AZ_AXI_BENCH_OWNER_CAPTURE: "1", AZ_AXI_BENCH_FILE: file,
      AZ_AXI_BENCH_LEAK_CHECK: JSON.stringify(targets.leakCheck) },
  });
  // CLI output and errors can contain owner identifiers; never print or persist either.
  if (child.error || child.status !== 0) {
    rmSync(file, { force: true });
    throw new Error(`Capture failed for ${scenario.name}; no response output saved`);
  }
  process.stderr.write(`Captured ${scenario.name}\n`);
}
