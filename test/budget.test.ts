// Token budgets per command (PLAN.md Sections 8 and 10.4 step 6).
//
// Each scenario drives a command handler with the shared synthetic payloads in
// test/samples.ts, renders the result to TOON exactly as runAxiCli would, and
// counts tokens with gpt-tokenizer (the counter PLAN.md Sections 4.4 and 13.4
// name; already a devDependency, so no new dependency).
//
// Ceiling rule: measured TOON token size plus 20 percent, rounded up. When a
// command's output shape changes, re-measure, update the ceiling, and justify
// any increase in the PR description.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode as encodeToon } from "@toon-format/toon";
import { encode as encodeTokens } from "gpt-tokenizer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), requestAll: vi.fn() }));
vi.mock("../src/lib/auth.js", () => ({ runAz: vi.fn(), identityOf: vi.fn(), resolveCredential: vi.fn() }));
vi.mock("../src/lib/stdin.js", () => ({ readStdinIfPiped: vi.fn() }));

import { run as runHome } from "../src/commands/home.js";
import { run as runDoctor } from "../src/commands/doctor.js";
import { run as runConfig } from "../src/commands/config.js";
import { run as runSub } from "../src/commands/sub.js";
import { run as runRg } from "../src/commands/rg.js";
import { run as runRbac } from "../src/commands/rbac.js";
import { run as runActivity } from "../src/commands/activity.js";
import { run as runDefender } from "../src/commands/defender.js";
import { run as runExposure } from "../src/commands/exposure.js";
import { run as runLogs } from "../src/commands/logs.js";
import { run as runApi } from "../src/commands/api.js";
import { identityOf, resolveCredential, runAz } from "../src/lib/auth.js";
import { requestAll, sendRequest } from "../src/lib/client.js";
import { collapseHomeDirectory } from "../src/lib/paths.js";
import {
  DEFENDER_ACTIVE_ALERT_COUNTS,
  EXPOSURE_ANY_ANY,
  EXPOSURE_MGMT_PORTS,
  EXPOSURE_PUBLIC_IPS,
} from "../src/lib/queries.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import {
  SUB_A,
  WORKSPACE,
  activityEvents,
  apiListResponse,
  configListProfiles,
  defenderAlertDetail,
  defenderAlerts,
  defenderAssessments,
  defenderScores,
  exposureAnyAny,
  exposureMgmtPorts,
  exposurePublicIps,
  graphNames,
  homeAlertCounts,
  logsResponse,
  rbacAssignments,
  resourceGraphPage,
  sampleIdentity,
  subscriptionList,
} from "./samples.js";

const sendMock = vi.mocked(sendRequest);
const allMock = vi.mocked(requestAll);
const identityMock = vi.mocked(identityOf);
const credentialMock = vi.mocked(resolveCredential);
const runAzMock = vi.mocked(runAz);

const ok = (body: unknown) => ({ status: 200, headers: {}, body, clientRequestId: "r" }) as never;

// Measured TOON tokens plus 20 percent, rounded up. Re-measure with a failing
// run (the assertion prints the actual size) after any output shape change.
const CEILINGS: Record<string, number> = {
  home: 227,
  doctor: 102,
  "config list": 146,
  "sub list": 136,
  "rg query": 204,
  "rbac list": 150,
  "activity list": 201,
  "defender alerts": 194,
  "defender alerts get": 112,
  "defender assessments": 117,
  "defender score": 86,
  exposure: 298,
  "logs query": 184,
  api: 135,
};

function tokensOf(result: Record<string, unknown>): number {
  // Machine-dependent paths must not consume the output-shape allowance.
  const normalized = {
    ...result,
    ...(typeof result.bin === "string" ? { bin: "az-axi" } : {}),
    ...(typeof result.config === "string"
      ? { config: result.config.replace(collapseHomeDirectory(process.env.AZ_AXI_CONFIG!), "/config.json") }
      : {}),
  };
  return encodeTokens(encodeToon(normalized)).length;
}

async function expectUnderBudget(key: string, result: Record<string, unknown>): Promise<void> {
  const tokens = tokensOf(result);
  expect(tokens, `${key}: ${tokens} tokens exceeds ceiling ${CEILINGS[key]}`).toBeLessThanOrEqual(CEILINGS[key] ?? 0);
}

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT", "AZ_AXI_READ_ONLY"];
let saved: Record<string, string | undefined>;

const subItems = () =>
  subscriptionList.map((s) => ({ subscriptionId: s.subscriptionId, displayName: s.displayName }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-budget-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  clearSubscriptionCache();
  sendMock.mockReset();
  allMock.mockReset();
  identityMock.mockReset();
  credentialMock.mockReset();
  runAzMock.mockReset();
  identityMock.mockResolvedValue({ ...sampleIdentity, type: "user" } as never);
  credentialMock.mockResolvedValue({ header: "Bearer x", mode: "az" } as never);
  runAzMock.mockResolvedValue("{}" as never);
  allMock.mockResolvedValue({ items: subItems() } as never);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
  clearSubscriptionCache();
});

describe("token budgets", () => {
  it("home stays under its ceiling", async () => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      const query = String((options["body"] as { query?: string })?.query ?? "");
      if (query.includes("securescores")) return ok({ totalRecords: defenderScores.length, data: defenderScores });
      if (query === DEFENDER_ACTIVE_ALERT_COUNTS) {
        return ok({ totalRecords: homeAlertCounts.length, data: homeAlertCounts });
      }
      return ok({ totalRecords: 2 });
    });
    await expectUnderBudget("home", await runHome([]));
  });

  it("doctor stays under its ceiling", async () => {
    allMock.mockResolvedValue({ items: [{}, {}, {}] } as never);
    await expectUnderBudget("doctor", await runDoctor([]));
  });

  it("config list stays under its ceiling", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(configListProfiles));
    await expectUnderBudget("config list", await runConfig(["list"]));
  });

  it("sub list stays under its ceiling", async () => {
    allMock.mockResolvedValue({ items: subscriptionList } as never);
    await expectUnderBudget("sub list", await runSub(["list"]));
  });

  it("rg query stays under its ceiling", async () => {
    sendMock.mockResolvedValue(ok(resourceGraphPage));
    await expectUnderBudget("rg query", await runRg(["query", "Resources | take 5"]));
  });

  it("rbac list stays under its ceiling", async () => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) =>
      options["resource"] === "graph"
        ? ok(graphNames)
        : ok({ totalRecords: rbacAssignments.length, count: rbacAssignments.length, data: rbacAssignments }),
    );
    await expectUnderBudget("rbac list", await runRbac(["list"]));
  });

  it("activity list stays under its ceiling", async () => {
    sendMock.mockResolvedValue(ok({ value: activityEvents }));
    await expectUnderBudget(
      "activity list",
      await runActivity(["list", "--subscription", SUB_A, "--since", "24h"]),
    );
  });

  it("defender alerts stays under its ceiling", async () => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      const path = String(options["path"] ?? "");
      if (!path.endsWith("/alerts") && /\/alerts\/[^/]+$/i.test(path)) return ok(defenderAlertDetail);
      return ok({ value: defenderAlerts });
    });
    await expectUnderBudget("defender alerts", await runDefender(["alerts", "--subscription", SUB_A]));
  });

  it("defender alerts get stays under its ceiling", async () => {
    sendMock.mockResolvedValue(ok(defenderAlertDetail));
    const id = `/subscriptions/${SUB_A}/providers/Microsoft.Security/locations/westeurope/alerts/alert-1`;
    await expectUnderBudget("defender alerts get", await runDefender(["alerts", "get", id]));
  });

  it("defender assessments stays under its ceiling", async () => {
    sendMock.mockResolvedValue(ok({ totalRecords: defenderAssessments.length, data: defenderAssessments }));
    await expectUnderBudget("defender assessments", await runDefender(["assessments"]));
  });

  it("defender score stays under its ceiling", async () => {
    sendMock.mockResolvedValue(ok({ totalRecords: defenderScores.length, data: defenderScores }));
    await expectUnderBudget("defender score", await runDefender(["score"]));
  });

  it("exposure stays under its ceiling", async () => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      const query = String((options["body"] as { query?: string })?.query ?? "");
      const data =
        query === EXPOSURE_PUBLIC_IPS ? exposurePublicIps : query === EXPOSURE_MGMT_PORTS ? exposureMgmtPorts : exposureAnyAny;
      return ok({ totalRecords: data.length, data });
    });
    await expectUnderBudget("exposure", await runExposure([]));
  });

  it("logs query stays under its ceiling", async () => {
    sendMock.mockResolvedValue(ok(logsResponse));
    await expectUnderBudget(
      "logs query",
      await runLogs(["query", "SigninLogs | take 5", "--workspace", WORKSPACE]),
    );
  });

  it("api stays under its ceiling", async () => {
    sendMock.mockResolvedValue(ok(apiListResponse));
    await expectUnderBudget(
      "api",
      await runApi(["GET", "/subscriptions", "--api-version", "2022-12-01"]),
    );
  });
});
