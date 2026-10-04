import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "@toon-format/toon";
import { scenarios } from "../../benchmark/scenarios.mjs";
import { countTokens } from "./tokens.mjs";
import { scrub } from "./scrub.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (process.argv.length !== 2) throw new Error("Usage: pnpm bench (see BENCHMARK.md)");
const replayScenarios = scenarios.filter((scenario) => {
  if (scenario.ownerTarget && !existsSync(new URL(`../../benchmark/fixtures/${scenario.name}.json`, import.meta.url))) {
    process.stderr.write(`Skipped ${scenario.name}: optional capture is absent\n`);
    return false;
  }
  return true;
});
const files = replayScenarios.map((scenario) => new URL(`../../benchmark/fixtures/${scenario.name}.json`, import.meta.url));
// Read every capture before creating scratch files or starting a CLI.
const captures = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
const targetWorkspace = scrub(JSON.parse(readFileSync(new URL("../../benchmark/targets.json", import.meta.url), "utf8")).workspace.toLowerCase());
const scratch = mkdtempSync(join(root, "benchmark/fixtures/replay-"));
try {
  const config = join(scratch, "config.json");
  const subscription = "00000000-0000-0000-0000-000000000001";
  const workspace = "00000000-0000-0000-0000-000000000010";
  writeFileSync(config, JSON.stringify({ defaultProfile: "benchmark", profiles: { benchmark: {
    auth: "token", subscriptions: [subscription],
    workspaces: { benchmark: workspace },
  } } }), { mode: 0o600 });
  const rows = replayScenarios.map((scenario, index) => {
    let replayFile = fileURLToPath(files[index]);
    if (scenario.name === "account-list" || scenario.name.startsWith("sentinel-")) {
      const capture = structuredClone(captures[index]);
      const items = capture.responses.flatMap((response) => response.body?.value ?? []);
      if (scenario.name === "account-list") {
        const selectedId = items[0]?.subscriptionId;
        for (const account of items) {
          if (account.subscriptionId !== selectedId) continue;
          account.subscriptionId = subscription;
          if (account.id === `/subscriptions/${selectedId}`) account.id = `/subscriptions/${subscription}`;
        }
      } else {
        for (const item of items) {
          if (item.properties?.customerId === targetWorkspace) {
            item.properties.customerId = workspace;
          }
        }
      }
      replayFile = join(scratch, `${scenario.name}.json`);
      writeFileSync(replayFile, JSON.stringify(capture));
    }
    const child = spawnSync(process.execPath, ["--import", "./scripts/benchmark/fetch-hook.mjs", "dist/bin/az-axi.js",
      ...scenario.argv, "--profile", "benchmark", "--subscription", subscription], {
      cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: "", AZ_AXI_CONFIG: config, AZ_AXI_PROFILE: "benchmark",
        AZ_AXI_TENANT: "", AZ_AXI_SUBSCRIPTION: "", AZ_AXI_READ_ONLY: "1", AZ_AXI_BENCH_MODE: "replay",
        AZ_AXI_BENCH_FILE: replayFile, AZ_AXI_ARM_TOKEN: "benchmark-dummy",
        AZ_AXI_LOGS_TOKEN: "benchmark-dummy", AZ_AXI_GRAPH_TOKEN: "benchmark-dummy" },
    });
    if (child.error || child.status !== 0) throw new Error(`Replay failed for ${scenario.name}; recapture with this build`);
    const rawJson = captures[index].responses.reduce((total, response) => total + countTokens(JSON.stringify(response.body, null, 2)), 0);
    const toon = countTokens(child.stdout);
    return { scenario: scenario.name, rawJson, toon, savedPercent: rawJson ? Number(((1 - toon / rawJson) * 100).toFixed(1)) : 0 };
  });
  process.stdout.write(`${encode({ tokenizer: "o200k_base", rows })}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
