import { AxiError } from "axi-sdk-js";
import { RESOURCE_GRAPH_RESOURCES, SUBSCRIPTIONS_LIST } from "../lib/apiVersions.js";
import { assertKnownFlags, flagString, parseArgs } from "../lib/args.js";
import { identityOf } from "../lib/auth.js";
import { requestAll, sendRequest } from "../lib/client.js";
import { loadConfig, readOnlyForced, writeStatus } from "../lib/config.js";
import { graphScope, profileFromArgs, scopeFlags } from "../lib/context.js";
import { DESCRIPTION } from "../help.js";
import { collapseHomeDirectory, homeHeader } from "../lib/paths.js";
import { DEFENDER_ACTIVE_ALERT_COUNTS, DEFENDER_SECURE_SCORES, exposureQuery } from "../lib/queries.js";
import { commandMeta } from "../lib/registry.js";
import { resolveWriteLogPath } from "../lib/writeLog.js";

export const meta = commandMeta("home");

interface CountBody {
  totalRecords?: number;
  count?: number;
  data?: unknown[];
}

interface SubItem {
  subscriptionId?: string;
  displayName?: string;
}

interface AlertCount {
  severity?: string;
  alerts?: number;
}

interface ScoreRow {
  subscriptionId?: string;
  current?: number;
  max?: number;
  percent?: number;
}

interface GraphBody<T> {
  data?: T[];
  $skipToken?: string;
  resultTruncated?: string | boolean;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  informational: "Informational",
};

function severityLabel(value: string): string {
  return SEVERITY_LABEL[value.toLowerCase()] ?? (value || "(unknown)");
}

function severityRank(value: string): number {
  return SEVERITY_RANK[value.toLowerCase()] ?? 5;
}

/** Best-effort totalRecords for one Resource Graph query; undefined when the call fails. */
async function rgTotal(
  profile: ReturnType<typeof profileFromArgs>,
  query: string,
  scope: { subscriptions?: string[]; managementGroups?: string[] },
): Promise<number | undefined> {
  try {
    const response = await sendRequest<CountBody>(profile, {
      method: "POST",
      path: "/providers/Microsoft.ResourceGraph/resources",
      apiVersion: RESOURCE_GRAPH_RESOURCES,
      body: {
        query,
        ...(scope.subscriptions ? { subscriptions: scope.subscriptions } : {}),
        ...(scope.managementGroups ? { managementGroups: scope.managementGroups } : {}),
        options: { $top: 1, resultFormat: "objectArray" },
      },
    });
    const body = response.body ?? {};
    if (typeof body.totalRecords === "number") return body.totalRecords;
    if (typeof body.count === "number") return body.count;
    return body.data?.length ?? 0;
  } catch {
    return undefined;
  }
}

async function rgRows<T>(
  profile: ReturnType<typeof profileFromArgs>,
  query: string,
  scope: { subscriptions?: string[]; managementGroups?: string[] },
  top: number,
): Promise<{ rows: T[]; truncated: boolean } | undefined> {
  try {
    const response = await sendRequest<GraphBody<T>>(profile, {
      method: "POST",
      path: "/providers/Microsoft.ResourceGraph/resources",
      apiVersion: RESOURCE_GRAPH_RESOURCES,
      body: {
        query,
        ...(scope.subscriptions ? { subscriptions: scope.subscriptions } : {}),
        ...(scope.managementGroups ? { managementGroups: scope.managementGroups } : {}),
        options: { $top: top, resultFormat: "objectArray" },
      },
    });
    const body = response.body ?? {};
    return {
      rows: body.data ?? [],
      truncated: Boolean(body.$skipToken) || body.resultTruncated === true || body.resultTruncated === "true",
    };
  } catch {
    return undefined;
  }
}

function percentOf(row: ScoreRow): number | undefined {
  if (typeof row.percent === "number" && Number.isFinite(row.percent)) return row.percent;
  if (typeof row.current === "number" && typeof row.max === "number" && row.max > 0) {
    return (row.current / row.max) * 100;
  }
  return undefined;
}

function subLabel(id: string, items: SubItem[] | undefined): string {
  const name = items?.find((item) => item.subscriptionId?.toLowerCase() === id.toLowerCase())?.displayName;
  return name || id || "(unknown subscription)";
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  assertKnownFlags(args, [], "home");
  if (args.positionals.length > 0) {
    throw new AxiError(`unexpected argument \`${args.positionals[0]}\` for \`home\``, "VALIDATION_ERROR", [
      "Run `az-axi` with no arguments for the dashboard",
      "Run `az-axi home --help` for usage",
    ]);
  }

  let profile: ReturnType<typeof profileFromArgs>;
  try {
    profile = profileFromArgs(args);
  } catch (err) {
    const error = err as AxiError;
    const { path, config } = loadConfig(flagString(args, "config"));
    const names = Object.keys(config?.profiles ?? {});
    return {
      ...homeHeader(DESCRIPTION),
      config: collapseHomeDirectory(path),
      profiles: names.length > 0 ? names : "(none; using the implicit az profile)",
      error: error.message,
      help: [
        ...error.suggestions,
        "Run `az-axi doctor` to check each profile",
        "Run `az-axi config init --name <name> --auth az` to create a profile",
      ],
    };
  }

  const scope = graphScope(profile, args);
  const suffix = scopeFlags(args);
  const [identitySettled, subsSettled, alertsSettled, scoresSettled, ipsSettled, portsSettled, anySettled] =
    await Promise.allSettled([
      profile.auth === "token"
        ? Promise.resolve({ name: "(token)", type: "token" as const, tenantId: profile.tenant ?? "" })
        : identityOf(profile),
      requestAll<SubItem>(profile, { path: "/subscriptions", apiVersion: SUBSCRIPTIONS_LIST }, 100),
      rgRows<AlertCount>(profile, DEFENDER_ACTIVE_ALERT_COUNTS, scope, 20),
      rgRows<ScoreRow>(profile, DEFENDER_SECURE_SCORES, scope, 1000),
      rgTotal(profile, exposureQuery("public-ips"), scope),
      rgTotal(profile, exposureQuery("mgmt-ports"), scope),
      rgTotal(profile, exposureQuery("any-any"), scope),
    ]);

  const help: string[] = [];
  const identity = identitySettled.status === "fulfilled" ? identitySettled.value : undefined;
  if (identitySettled.status === "rejected") {
    const error = identitySettled.reason as AxiError;
    help.push(`[identity] ${error instanceof AxiError ? error.message : String(error)}`);
    help.push(...(error instanceof AxiError ? error.suggestions.map((s) => `[identity] ${s}`) : []));
  }
  const subs = subsSettled.status === "fulfilled" ? subsSettled.value : undefined;
  if (subsSettled.status === "rejected") {
    const error = subsSettled.reason as AxiError;
    help.push(`[subscriptions] ${error instanceof AxiError ? error.message : String(error)}`);
  }

  const subscriptions = subs
    ? subs.nextLink
      ? `${subs.items.length}+`
      : subs.items.length
    : "-";

  const alerts = alertsSettled.status === "fulfilled" ? alertsSettled.value : undefined;
  let defender: unknown = "-";
  if (alerts) {
    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of alerts.rows) {
      const n = typeof row.alerts === "number" ? row.alerts : Number(row.alerts ?? Number.NaN);
      if (!Number.isFinite(n) || n <= 0) continue;
      const label = severityLabel(row.severity ?? "");
      counts[label] = (counts[label] ?? 0) + n;
      total += n;
    }
    if (total === 0) {
      defender = "0 active alerts";
    } else {
      const ordered = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => severityRank(a) - severityRank(b)));
      defender = { ...ordered, total };
    }
    if (alerts.truncated) {
      help.push("[defender] Alert counts may be incomplete; run `az-axi defender alerts`");
    }
  } else {
    help.push("[defender] Could not load active alert counts; run `az-axi defender alerts --severity High`");
  }

  const scores = scoresSettled.status === "fulfilled" ? scoresSettled.value : undefined;
  let score: unknown = "-";
  if (scores) {
    const ranked = scores.rows
      .map((row) => ({ id: row.subscriptionId ?? "", percent: percentOf(row) }))
      .filter((row): row is { id: string; percent: number } => row.percent !== undefined);
    if (ranked.length === 0) {
      score = "0 secure scores";
    } else {
      const average = ranked.reduce((sum, row) => sum + row.percent, 0) / ranked.length;
      const lowest = ranked.reduce((min, row) => (row.percent < min.percent ? row : min));
      score = {
        average: `${average.toFixed(1)}%`,
        lowest: subLabel(lowest.id, subs?.items),
        lowestPercent: `${lowest.percent.toFixed(1)}%`,
      };
    }
    if (scores.truncated) help.push("[score] Secure score average was truncated; narrow with --subscription");
  } else {
    help.push("[score] Could not load secure scores; run `az-axi defender score`");
  }

  const ips = ipsSettled.status === "fulfilled" ? ipsSettled.value : undefined;
  const ports = portsSettled.status === "fulfilled" ? portsSettled.value : undefined;
  const any = anySettled.status === "fulfilled" ? anySettled.value : undefined;
  let exposure: unknown = "-";
  if (ips === undefined && ports === undefined && any === undefined) {
    help.push("[exposure] Could not load exposure counts; run `az-axi exposure`");
  } else {
    exposure = {
      ...(ips !== undefined ? { publicIps: ips } : {}),
      ...(ports !== undefined ? { mgmtPorts: ports } : {}),
      ...(any !== undefined ? { anyAny: any } : {}),
    };
    if (ips === undefined) help.push(`[exposure] Could not count public IPs; run \`az-axi exposure --check public-ips${suffix}\``);
    if (ports === undefined) {
      help.push(`[exposure] Could not count management ports; run \`az-axi exposure --check mgmt-ports${suffix}\``);
    }
    if (any === undefined) help.push(`[exposure] Could not count any-any rules; run \`az-axi exposure --check any-any${suffix}\``);
  }

  const row = {
    ...homeHeader(DESCRIPTION),
    profile: profile.name,
    identity: identity?.name ?? (profile.auth === "token" ? "(token)" : "-"),
    type: identity?.type ?? (profile.auth === "token" ? "token" : "-"),
    tenant: identity && "tenantId" in identity && identity.tenantId ? identity.tenantId : (profile.tenant ?? ""),
    subscriptions,
    defender,
    score,
    exposure,
    writes: writeStatus(profile.allowWrites, profile.writeSubscriptions).label,
    writeSubscriptions: profile.allowWrites === true ? profile.writeSubscriptions : [],
    readOnly: { set: process.env.AZ_AXI_READ_ONLY !== undefined, forced: readOnlyForced() },
    writeLog: collapseHomeDirectory(resolveWriteLogPath()),
  };

  const next: string[] = [];
  if (defender && typeof defender === "object" && ("High" in defender || "Critical" in defender)) {
    next.push(`Run \`az-axi defender alerts --severity High${suffix}\``);
  }
  const exposureCounts = typeof exposure === "object" && exposure ? (exposure as Record<string, number>) : {};
  const portCount = exposureCounts["mgmtPorts"] ?? 0;
  const anyCount = exposureCounts["anyAny"] ?? 0;
  const ipCount = exposureCounts["publicIps"] ?? 0;
  if (portCount > 0) next.push(`Run \`az-axi exposure --check mgmt-ports${suffix}\``);
  else if (anyCount > 0) next.push(`Run \`az-axi exposure --check any-any${suffix}\``);
  else if (ipCount > 0) next.push(`Run \`az-axi exposure --check public-ips${suffix}\``);
  if (typeof score === "object") next.push(`Run \`az-axi defender assessments --severity High${suffix}\``);
  if (next.length < 3) next.push(`Run \`az-axi sub list${suffix}\` to see visible subscriptions`);
  if (next.length < 3) next.push('Run `az-axi rg query "Resources | take 5"` for a first inventory');

  if (help.length > 0) help.push("Run `az-axi doctor` to diagnose this profile");
  help.push(...next.slice(0, 3));

  return { ...row, help };
}
