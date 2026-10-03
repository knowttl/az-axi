import { AxiError } from "axi-sdk-js";
import {
  DEFENDER_ALERTS,
  RESOURCE_GRAPH_RESOURCES,
  SUBSCRIPTIONS_LIST,
} from "../lib/apiVersions.js";
import {
  assertKnownFlags,
  flagBool,
  flagList,
  flagNumber,
  flagText,
  parseArgs,
  type ParsedArgs,
} from "../lib/args.js";
import { requestAll, sendRequest, type ApiResponse } from "../lib/client.js";
import { graphScope, profileFromArgs, scopeFlags } from "../lib/context.js";
import { countLine, emptyState, pickFields, shortDate, truncate } from "../lib/format.js";
import { DEFENDER_SECURE_SCORES, defenderAssessmentsQuery } from "../lib/queries.js";
import { commandMeta } from "../lib/registry.js";
import { parseSubscriptionId, shortenResourceId, subscriptionNameMap } from "../lib/scope.js";
import { parseSince } from "../lib/time.js";
import type { ResolvedProfile } from "../lib/config.js";

export const meta = commandMeta("defender");

const SUBCOMMANDS = ["alerts", "assessments", "score"] as const;
const ALERT_FLAGS = ["severity", "status", "since"] as const;
const ASSESSMENT_FLAGS = ["severity", "status", "resource", "show-query"] as const;
const DEFAULT_ALERTS_LIMIT = 50;
const DEFAULT_ASSESSMENTS_LIMIT = 25;
const MAX_LIMIT = 1000;
const FETCH_TOP = 1000;
const MAX_PAGES = 10;
const CONCURRENCY = 4;
const CELL_TRUNCATE = 200;
const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALERT_ID = /\/providers\/microsoft\.security\/locations\/[^/]+\/alerts\/[^/?#]+$/i;

const SUBSCRIPTIONS_IN_GROUP = [
  "resourcecontainers",
  '| where type =~ "microsoft.resources/subscriptions"',
  "| project subscriptionId, id",
].join("\n");

/** Worst first, so grouped output answers triage questions without a second call. */
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

function severityRank(severity: string | undefined): number {
  return SEVERITY_RANK[(severity ?? "").toLowerCase()] ?? 5;
}

interface AlertProperties {
  alertDisplayName?: string;
  displayName?: string;
  description?: string;
  severity?: string;
  status?: string;
  timeGeneratedUtc?: string;
  remediationSteps?: string[] | string;
  compromisedEntity?: string;
  resourceIdentifiers?: Array<{ azureResourceId?: string }>;
  entities?: unknown[];
}

interface Alert {
  id?: string;
  name?: string;
  properties?: AlertProperties;
}

interface AlertsListResponse {
  value?: Alert[];
  nextLink?: string;
}

interface AssessmentRow {
  recommendation?: string;
  severity?: string;
  status?: string;
  resourceId?: string;
  subscriptionId?: string;
  id?: string;
}

interface ResourceGraphResponse<T> {
  totalRecords?: number;
  count?: number;
  data?: T[];
  $skipToken?: string;
  resultTruncated?: string | boolean;
}

interface ScoreRow {
  subscriptionId?: string;
  current?: number;
  max?: number;
  percent?: number;
  id?: string;
}

function formatCell(value: unknown, full: boolean): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return full ? value : truncate(value, CELL_TRUNCATE).text;
  return value;
}

function eventTime(value: string | undefined): number {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
}

function assertSubscriptionIds(ids: readonly string[]): void {
  const bad = ids.find((id) => !SUBSCRIPTION_ID.test(id));
  if (!bad) return;
  throw new AxiError(`'${bad}' is not a subscription ID`, "VALIDATION_ERROR", [
    "Pass a GUID from `az-axi sub list`",
    "Example: --subscription 00000000-0000-0000-0000-000000000001",
  ]);
}

function entitySummary(entities: unknown[]): string {
  if (entities.length === 0) return "0 entities";
  const counts = new Map<string, number>();
  for (const entity of entities) {
    const type =
      entity && typeof entity === "object" && "type" in entity && typeof (entity as { type?: unknown }).type === "string"
        ? (entity as { type: string }).type
        : "entity";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => `${type}: ${count}`).join(", ");
}

function resourceNames(row: AssessmentRow): string[] {
  const names: string[] = [];
  const direct = (row.resourceId ?? "").split("/").filter(Boolean).pop();
  if (direct) names.push(direct);
  const stripped = (row.id ?? "").replace(/\/providers\/microsoft\.security\/assessments\/[^/]+$/i, "");
  const embedded = stripped.split("/").filter(Boolean).pop();
  if (embedded) names.push(embedded);
  return names.map((name) => name.toLowerCase());
}

function resourceRowMatches(row: AssessmentRow, filter: string): boolean {
  const wanted = filter.trim().toLowerCase();
  const ids = [row.resourceId, row.id].filter((id): id is string => Boolean(id));
  if (wanted.startsWith("/")) {
    return ids.some((id) => {
      const value = id.toLowerCase();
      return value === wanted || value.startsWith(`${wanted}/`);
    });
  }
  return resourceNames(row).includes(wanted);
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function subscriptionsInManagementGroup(profile: ResolvedProfile, managementGroup: string): Promise<string[]> {
  const ids: string[] = [];
  let skipToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await sendRequest<ResourceGraphResponse<{ subscriptionId?: string; id?: string }>>(profile, {
      method: "POST",
      path: "/providers/Microsoft.ResourceGraph/resources",
      apiVersion: RESOURCE_GRAPH_RESOURCES,
      body: {
        query: SUBSCRIPTIONS_IN_GROUP,
        managementGroups: [managementGroup],
        options: {
          $top: 1000,
          resultFormat: "objectArray",
          ...(skipToken ? { $skipToken: skipToken } : {}),
        },
      },
    });
    for (const row of response.body?.data ?? []) {
      const id = row.subscriptionId || parseSubscriptionId(row.id ?? "");
      if (id) ids.push(id);
    }
    const next = response.body?.$skipToken;
    if (!next) break;
    skipToken = next;
  }
  return uniqueIds(ids);
}

async function accessibleSubscriptions(profile: ResolvedProfile): Promise<string[]> {
  const { items } = await requestAll<{ subscriptionId: string }>(
    profile,
    { path: "/subscriptions", apiVersion: SUBSCRIPTIONS_LIST },
    100,
  );
  return uniqueIds(items.map((sub) => sub.subscriptionId).filter(Boolean));
}

/**
 * ARM has no management-group fan-out, so a group expands to subscriptions first.
 * Matches `activity list` scope precedence: --management-group, --subscription,
 * $AZ_AXI_SUBSCRIPTION, profile managementGroup, profile subscriptions, all visible.
 */
async function resolveSubscriptionIds(
  profile: ResolvedProfile,
  args: ParsedArgs,
): Promise<{ ids: string[]; label: string }> {
  const flagMg = flagText(args, "management-group");
  if (args.flags["subscription"] === true || args.flags["subscription"] === "") {
    throw new AxiError("flag --subscription needs a non-empty value", "VALIDATION_ERROR", [
      "Example: --subscription <id>",
    ]);
  }
  const flagSubs = flagList(args, "subscription");
  const envSubs = uniqueIds(
    (process.env.AZ_AXI_SUBSCRIPTION ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );

  if (flagMg) {
    return { ids: await subscriptionsInManagementGroup(profile, flagMg), label: `in management group ${flagMg}` };
  }
  if (flagSubs?.length) {
    const ids = uniqueIds(flagSubs);
    assertSubscriptionIds(ids);
    return { ids, label: `for ${ids.length} subscription${ids.length === 1 ? "" : "s"}` };
  }
  if (envSubs.length > 0) {
    assertSubscriptionIds(envSubs);
    return { ids: envSubs, label: `for ${envSubs.length} subscription${envSubs.length === 1 ? "" : "s"}` };
  }
  if (profile.managementGroup) {
    return {
      ids: await subscriptionsInManagementGroup(profile, profile.managementGroup),
      label: `in management group ${profile.managementGroup}`,
    };
  }
  if (profile.subscriptions?.length) {
    const ids = uniqueIds(profile.subscriptions);
    assertSubscriptionIds(ids);
    return { ids, label: `for ${ids.length} subscription${ids.length === 1 ? "" : "s"}` };
  }
  const ids = await accessibleSubscriptions(profile);
  return { ids, label: `for ${ids.length} subscription${ids.length === 1 ? "" : "s"}` };
}

function resolveLimit(args: ParsedArgs, def: number): number {
  if (args.flags["limit"] === true || args.flags["limit"] === "") {
    throw new AxiError("flag --limit needs a number", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }
  const full = flagBool(args, "full");
  const limit = full ? Number.POSITIVE_INFINITY : (flagNumber(args, "limit") ?? def);
  if (!(limit > 0)) {
    throw new AxiError("flag --limit must be greater than 0", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }
  if (limit !== Number.POSITIVE_INFINITY && limit > MAX_LIMIT) {
    throw new AxiError(`flag --limit must be at most ${MAX_LIMIT}`, "VALIDATION_ERROR", [
      `Example: --limit ${MAX_LIMIT}`,
    ]);
  }
  return limit;
}

function alertResourceId(alert: Alert): string {
  const identifiers = alert.properties?.resourceIdentifiers ?? [];
  for (const entry of identifiers) {
    if (entry.azureResourceId) return entry.azureResourceId;
  }
  return alert.properties?.compromisedEntity ?? alert.id ?? "";
}

function alertTitle(alert: Alert): string {
  return alert.properties?.alertDisplayName ?? alert.properties?.displayName ?? alert.name ?? "";
}

async function fetchSubscriptionAlerts(
  profile: ResolvedProfile,
  subId: string,
): Promise<{ alerts: Alert[]; error?: unknown; truncated: boolean }> {
  const alerts: Alert[] = [];
  const seenLinks = new Set<string>();
  let path: string | undefined = `/subscriptions/${subId}/providers/Microsoft.Security/alerts`;
  let pages = 0;
  let truncated = false;
  try {
    while (path && pages < MAX_PAGES) {
      if (seenLinks.has(path)) {
        truncated = true;
        path = undefined;
        break;
      }
      seenLinks.add(path);
      const current: string = path;
      const response: ApiResponse<AlertsListResponse> = await sendRequest<AlertsListResponse>(profile, {
        method: "GET",
        path: current,
        apiVersion: DEFENDER_ALERTS,
      });
      pages++;
      alerts.push(...(response.body?.value ?? []));
      path = response.body?.nextLink ?? undefined;
    }
    if (path) truncated = true;
    return { alerts, truncated };
  } catch (err) {
    return { alerts, error: err, truncated };
  }
}

async function runAlerts(profile: ResolvedProfile, args: ParsedArgs): Promise<Record<string, unknown>> {
  if (args.positionals[1] === "get") {
    return runAlertGet(profile, args);
  }
  if (args.positionals.length > 1) {
    throw new AxiError(`unexpected argument \`${args.positionals[1]}\` for \`defender alerts\``, "VALIDATION_ERROR", [
      "Run `az-axi defender alerts get <alert-resource-id>` for one alert",
      "Run `az-axi defender alerts --help` for usage",
    ]);
  }

  const full = flagBool(args, "full");
  const limit = resolveLimit(args, DEFAULT_ALERTS_LIMIT);
  const fields = flagList(args, "fields");
  const severities = flagText(args, "severity")?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const statusRaw = flagText(args, "status");
  const statuses =
    statusRaw === undefined
      ? ["active"]
      : statusRaw.toLowerCase() === "all"
        ? undefined
        : statusRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const sinceRaw = flagText(args, "since");
  const sinceMs = sinceRaw ? parseSince(sinceRaw).getTime() : undefined;
  const suffix = scopeFlags(args);

  const scope = await resolveSubscriptionIds(profile, args);
  if (scope.ids.length === 0) {
    return {
      profile: profile.name,
      total: 0,
      count: countLine(0, 0, "alerts"),
      rows: emptyState("Defender alerts", scope.label),
      help: ["Run `az-axi sub list` to verify the subscriptions in scope"],
    };
  }

  const fetched = await mapPool(scope.ids, CONCURRENCY, (subId) => fetchSubscriptionAlerts(profile, subId));
  const failures = fetched.filter((item) => item.error);
  const truncated = fetched.some((item) => item.truncated);
  const seenIds = new Set<string>();
  let collected = fetched.flatMap((item) => item.alerts).filter((alert) => {
    const key = alert.id?.toLowerCase();
    if (!key) return true;
    if (seenIds.has(key)) return false;
    seenIds.add(key);
    return true;
  });
  if (collected.length === 0 && failures.length > 0) {
    const err = failures[0]?.error;
    if (err instanceof Error) throw err;
    throw new AxiError("Defender alerts query failed", "API_ERROR", ["Run `az-axi doctor` to verify the profile"]);
  }

  collected = collected.filter((alert) => {
    const props = alert.properties ?? {};
    if (severities?.length && !severities.includes((props.severity ?? "").toLowerCase())) return false;
    if (statuses && !statuses.includes((props.status ?? "").toLowerCase())) return false;
    if (sinceMs !== undefined && eventTime(props.timeGeneratedUtc) < sinceMs) return false;
    return true;
  });
  collected.sort((a, b) => eventTime(b.properties?.timeGeneratedUtc) - eventTime(a.properties?.timeGeneratedUtc));

  const scopeHint = `${scope.label}${sinceRaw ? ` since ${sinceRaw}` : ""}`;
  if (collected.length === 0) {
    return {
      profile: profile.name,
      total: 0,
      count: countLine(0, 0, "alerts"),
      rows: emptyState("Defender alerts", scopeHint),
      help: [
        `Widen the window: \`az-axi defender alerts --since 30d${suffix}\``,
        `Include every status: \`az-axi defender alerts --status all${suffix}\``,
      ],
    };
  }

  const bySeverity: Record<string, number> = {};
  for (const alert of collected) {
    const severity = alert.properties?.severity || "(unknown)";
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
  }
  const sortedBySeverity = Object.fromEntries(
    Object.entries(bySeverity).sort(([a], [b]) => severityRank(a) - severityRank(b)),
  );

  const names = full ? undefined : await subscriptionNameMap(profile);
  const extended = collected.map((alert) => ({
    time: shortDate(alert.properties?.timeGeneratedUtc),
    severity: formatCell(alert.properties?.severity ?? "", full),
    alert: formatCell(alertTitle(alert), full),
    resource: formatCell(full ? alertResourceId(alert) : shortenResourceId(alertResourceId(alert), names), full),
    status: formatCell(alert.properties?.status ?? "", full),
    id: formatCell(
      full || fields?.includes("id") ? (alert.id ?? "") : shortenResourceId(alert.id ?? "", names),
      full,
    ),
    subscription: formatCell(parseSubscriptionId(alert.id ?? "") ?? "", full),
  }));

  const shown = full ? extended : extended.slice(0, limit);
  const picked = fields
    ? pickFields(shown, fields)
    : pickFields(shown, ["time", "severity", "alert", "resource", "status"]);

  const help: string[] = [];
  if (failures.length > 0) {
    help.push(`Could not query ${failures.length} subscription${failures.length === 1 ? "" : "s"}; counts cover the rest`);
  }
  if (truncated) {
    help.push("Alert lists were capped at 10 pages per subscription; narrow with --subscription or --since");
  }
  if (picked.length > 0 && typeof picked[0] === "object") {
    const firstId = collected[0]?.id;
    if (firstId) help.push(`Run \`az-axi defender alerts get ${firstId}\` for the newest alert in detail`);
  }

  return {
    profile: profile.name,
    total: collected.length,
    count: countLine(shown.length, collected.length, "alerts"),
    bySeverity: sortedBySeverity,
    rows: picked,
    ...(help.length > 0 ? { help: help.slice(0, 3) } : {}),
  };
}

async function runAlertGet(profile: ResolvedProfile, args: ParsedArgs): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const id = args.positionals[2];
  if (!id) {
    throw new AxiError("missing alert id for `defender alerts get`", "VALIDATION_ERROR", [
      "Run `az-axi defender alerts` to list alert resource IDs",
      "Example: `az-axi defender alerts get /subscriptions/<id>/providers/Microsoft.Security/locations/<loc>/alerts/<name>`",
    ]);
  }
  if (args.positionals.length > 3) {
    throw new AxiError(`unexpected argument \`${args.positionals[3]}\` for \`defender alerts get\``, "VALIDATION_ERROR", [
      "Pass one alert resource ID from the list output",
    ]);
  }
  if (!id.startsWith("/") || !ALERT_ID.test(id.split("?")[0] ?? "")) {
    throw new AxiError("alert id must be the full alert resource ID from the list output", "VALIDATION_ERROR", [
      "Example: /subscriptions/<id>/providers/Microsoft.Security/locations/<loc>/alerts/<name>",
      "Run `az-axi defender alerts` to list alert resource IDs",
    ]);
  }

  const response = await sendRequest<{ properties?: AlertProperties; name?: string }>(profile, {
    method: "GET",
    path: id,
    apiVersion: DEFENDER_ALERTS,
  });
  const props = response.body?.properties ?? {};
  const description = props.description ?? "";
  const remediation =
    Array.isArray(props.remediationSteps) ? props.remediationSteps.join("\n") : (props.remediationSteps ?? "");
  const descriptionText = full ? { text: description, truncated: false } : truncate(description, CELL_TRUNCATE);
  const remediationText = full ? { text: remediation, truncated: false } : truncate(remediation, CELL_TRUNCATE);
  const help: string[] = [];
  if (!full && (descriptionText.truncated || remediationText.truncated)) {
    help.push(`Run \`az-axi defender alerts get ${id} --full\` for the complete text`);
  }

  return {
    profile: profile.name,
    alert: alertTitle({ properties: props, name: response.body?.name }),
    severity: props.severity ?? "",
    status: props.status ?? "",
    time: shortDate(props.timeGeneratedUtc),
    resource: full ? alertResourceId({ properties: props, id }) : shortenResourceId(alertResourceId({ properties: props, id })),
    description: descriptionText.text,
    remediation: remediationText.text,
    entities: entitySummary(props.entities ?? []),
    ...(help.length > 0 ? { help } : {}),
  };
}

async function fetchAssessmentRows(
  profile: ResolvedProfile,
  query: string,
  subscriptions: string[] | undefined,
  managementGroups: string[] | undefined,
): Promise<{ rows: AssessmentRow[]; totalRecords?: number; incomplete: boolean }> {
  const rows: AssessmentRow[] = [];
  const seenTokens = new Set<string>();
  let skipToken: string | undefined;
  let totalRecords: number | undefined;
  let incomplete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (skipToken) {
      if (seenTokens.has(skipToken)) {
        incomplete = true;
        break;
      }
      seenTokens.add(skipToken);
    }
    const response = await sendRequest<ResourceGraphResponse<AssessmentRow>>(profile, {
      method: "POST",
      path: "/providers/Microsoft.ResourceGraph/resources",
      apiVersion: RESOURCE_GRAPH_RESOURCES,
      body: {
        query,
        ...(subscriptions ? { subscriptions } : {}),
        ...(managementGroups ? { managementGroups } : {}),
        options: {
          $top: FETCH_TOP,
          ...(skipToken ? { $skipToken: skipToken } : {}),
          resultFormat: "objectArray",
        },
      },
    });
    const body = response.body ?? {};
    if (totalRecords === undefined && typeof body.totalRecords === "number") totalRecords = body.totalRecords;
    rows.push(...(body.data ?? []));
    if (body.resultTruncated === true || body.resultTruncated === "true") incomplete = true;
    const next = body.$skipToken;
    if (!next) {
      skipToken = undefined;
      break;
    }
    skipToken = next;
    if (page === MAX_PAGES - 1) incomplete = true;
  }

  return { rows, totalRecords, incomplete };
}

async function runAssessments(profile: ResolvedProfile, args: ParsedArgs): Promise<Record<string, unknown>> {
  if (args.positionals.length > 1) {
    throw new AxiError(`unexpected argument \`${args.positionals[1]}\` for \`defender assessments\``, "VALIDATION_ERROR", [
      "Run `az-axi defender assessments --help` for usage",
    ]);
  }
  const full = flagBool(args, "full");
  const limit = resolveLimit(args, DEFAULT_ASSESSMENTS_LIMIT);
  const fields = flagList(args, "fields");
  const severityFilter = flagText(args, "severity");
  const statusFilter = flagText(args, "status");
  const resourceFilter = flagText(args, "resource");
  const suffix = scopeFlags(args);
  const query = defenderAssessmentsQuery({
    ...(severityFilter ? { severity: severityFilter } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(resourceFilter ? { resource: resourceFilter } : {}),
  });
  const replay = ["az-axi defender assessments"];
  if (severityFilter) replay.push(`--severity ${severityFilter}`);
  if (statusFilter) replay.push(`--status ${statusFilter}`);
  if (resourceFilter) replay.push(`--resource ${resourceFilter}`);
  const replayCommand = `\`${replay.join(" ")}${suffix}\``;

  if (flagBool(args, "show-query")) {
    const scope = graphScope(profile, args);
    return {
      profile: profile.name,
      query,
      ...(scope.managementGroups ? { managementGroups: scope.managementGroups } : {}),
      ...(scope.subscriptions ? { subscriptions: scope.subscriptions } : {}),
      help: [`Run ${replayCommand} to execute this query`],
    };
  }

  const scope = graphScope(profile, args);
  const fetched = await fetchAssessmentRows(profile, query, scope.subscriptions, scope.managementGroups);
  let rows = fetched.rows;
  const severities = severityFilter?.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (severities?.length) {
    rows = rows.filter((row) => severities.includes((row.severity ?? "").toLowerCase()));
  }
  const statuses =
    statusFilter && statusFilter.toLowerCase() !== "all"
      ? statusFilter.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)
      : undefined;
  if (statuses?.length) {
    rows = rows.filter((row) => statuses.includes((row.status ?? "").toLowerCase()));
  }

  if (resourceFilter) {
    const matches = rows.filter((row) => resourceRowMatches(row, resourceFilter));
    const names = full ? undefined : await subscriptionNameMap(profile);
    const extended = matches.map((row) => {
      const resourceId = row.resourceId || row.id || "";
      return {
        resource: formatCell(full ? resourceId : shortenResourceId(resourceId, names), full),
        severity: formatCell(row.severity ?? "", full),
        status: formatCell(row.status ?? "", full),
        recommendation: formatCell(row.recommendation ?? "", full),
        subscription: formatCell(row.subscriptionId ?? "", full),
      };
    });
    const shown = full ? extended : extended.slice(0, limit);
    const picked = fields ? pickFields(shown, fields) : pickFields(shown, ["resource", "severity", "status", "recommendation"]);
    if (matches.length === 0) {
      return {
        profile: profile.name,
        total: 0,
        count: countLine(0, 0, "assessments"),
        rows: emptyState("assessment results", `matching ${resourceFilter} ${scope.label}`),
        help: [`Run \`az-axi defender assessments${suffix}\` for one row per recommendation`],
      };
    }
    return {
      profile: profile.name,
      total: matches.length,
      count: countLine(shown.length, matches.length, "assessments"),
      rows: picked,
    };
  }

  const grouped = new Map<string, { recommendation: string; severity: string; healthy: number; unhealthy: number; notApplicable: number }>();
  for (const row of rows) {
    const recommendation = row.recommendation || "(unknown recommendation)";
    const entry = grouped.get(recommendation) ?? {
      recommendation,
      severity: row.severity ?? "",
      healthy: 0,
      unhealthy: 0,
      notApplicable: 0,
    };
    if (!entry.severity && row.severity) entry.severity = row.severity;
    const status = (row.status ?? "").toLowerCase();
    if (status === "healthy") entry.healthy++;
    else if (status === "unhealthy") entry.unhealthy++;
    else entry.notApplicable++;
    grouped.set(recommendation, entry);
  }
  const recommendations = [...grouped.values()].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.unhealthy - a.unhealthy,
  );

  if (recommendations.length === 0) {
    return {
      profile: profile.name,
      total: 0,
      count: countLine(0, 0, "recommendations"),
      rows: emptyState("Defender recommendations", scope.label),
      help: ["Run `az-axi sub list` to verify the subscriptions in scope"],
    };
  }

  const bySeverity: Record<string, number> = {};
  let unhealthyTotal = 0;
  for (const entry of recommendations) {
    unhealthyTotal += entry.unhealthy;
    if (entry.unhealthy > 0) {
      const severity = entry.severity || "(unknown)";
      bySeverity[severity] = (bySeverity[severity] ?? 0) + entry.unhealthy;
    }
  }

  const shown = full ? recommendations : recommendations.slice(0, limit);
  const extended = shown.map((entry) => ({
    recommendation: formatCell(entry.recommendation, full),
    severity: formatCell(entry.severity, full),
    unhealthyCount: entry.unhealthy,
    healthy: entry.healthy,
    total: entry.unhealthy + entry.healthy + entry.notApplicable,
  }));
  const picked = fields
    ? pickFields(extended, fields)
    : pickFields(extended, ["recommendation", "severity", "unhealthyCount", "total"]);

  const help: string[] = [];
  if (fetched.incomplete) {
    help.push(`More assessments exist; narrow with \`az-axi defender assessments --severity High${suffix}\``);
  } else if (!severityFilter) {
    help.push(`Run \`az-axi defender assessments --severity High${suffix}\` to triage the worst first`);
  }

  return {
    profile: profile.name,
    total: recommendations.length,
    count: countLine(shown.length, recommendations.length, "recommendations"),
    unhealthy: unhealthyTotal,
    bySeverity,
    rows: picked,
    ...(help.length > 0 ? { help } : {}),
  };
}

async function runScore(profile: ResolvedProfile, args: ParsedArgs): Promise<Record<string, unknown>> {
  if (args.positionals.length > 1) {
    throw new AxiError(`unexpected argument \`${args.positionals[1]}\` for \`defender score\``, "VALIDATION_ERROR", [
      "Run `az-axi defender score --help` for usage",
    ]);
  }
  const full = flagBool(args, "full");
  const limit = resolveLimit(args, DEFAULT_ALERTS_LIMIT);
  const fields = flagList(args, "fields");
  const scope = graphScope(profile, args);
  const suffix = scopeFlags(args);

  const response = await sendRequest<ResourceGraphResponse<ScoreRow>>(profile, {
    method: "POST",
    path: "/providers/Microsoft.ResourceGraph/resources",
    apiVersion: RESOURCE_GRAPH_RESOURCES,
    body: {
      query: DEFENDER_SECURE_SCORES,
      ...(scope.subscriptions ? { subscriptions: scope.subscriptions } : {}),
      ...(scope.managementGroups ? { managementGroups: scope.managementGroups } : {}),
      options: { $top: FETCH_TOP, resultFormat: "objectArray" },
    },
  });
  const body = response.body ?? {};
  const rows = body.data ?? [];
  const truncated = Boolean(body.$skipToken) || body.resultTruncated === true || body.resultTruncated === "true";
  if (rows.length === 0) {
    return {
      profile: profile.name,
      total: 0,
      count: countLine(0, 0, "scores"),
      rows: emptyState("secure scores", scope.label),
      help: ["Run `az-axi sub list` to verify the subscriptions in scope"],
    };
  }

  const names = full ? undefined : await subscriptionNameMap(profile);
  const extended = rows
    .map((row) => {
      const current = typeof row.current === "number" ? row.current : Number(row.current ?? Number.NaN);
      const max = typeof row.max === "number" ? row.max : Number(row.max ?? Number.NaN);
      // The query scales `score.percentage` to 0-100; only recompute when it is absent.
      const percent =
        typeof row.percent === "number" && Number.isFinite(row.percent)
          ? Math.round(row.percent * 10) / 10
          : Number.isFinite(current) && Number.isFinite(max) && max > 0
            ? Math.round((current / max) * 1000) / 10
            : Number.NaN;
      const subId = row.subscriptionId ?? "";
      return {
        subscription: full ? subId : (names?.get(subId.toLowerCase()) ?? subId),
        current: Number.isFinite(current) ? current : "",
        max: Number.isFinite(max) ? max : "",
        percent: Number.isFinite(percent) ? percent : "",
        rank: Number.isFinite(percent) ? (percent as number) : Number.POSITIVE_INFINITY,
      };
    })
    .sort((a, b) => (a.rank as number) - (b.rank as number))
    .map(({ rank: _rank, ...row }) => row);

  const shown = full ? extended : extended.slice(0, limit);
  const picked = fields ? pickFields(shown, fields) : pickFields(shown, ["subscription", "current", "max", "percent"]);

  return {
    profile: profile.name,
    total: rows.length,
    count: countLine(shown.length, rows.length, "scores"),
    rows: picked,
    help: [
      `Run \`az-axi defender assessments --severity High${suffix}\` for what drags the lowest score down`,
      ...(truncated ? ["Secure scores were truncated; narrow with --subscription"] : []),
    ],
  };
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const sub = args.positionals[0];
  if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new AxiError(
      sub ? `unknown command \`defender ${sub}\`` : "missing subcommand for `defender`",
      "VALIDATION_ERROR",
      ["Run `az-axi defender alerts|assessments|score --help` for usage"],
    );
  }
  const getting = sub === "alerts" && args.positionals[1] === "get";
  const known = getting ? [] : sub === "alerts" ? ALERT_FLAGS : sub === "assessments" ? ASSESSMENT_FLAGS : [];
  assertKnownFlags(args, known, getting ? "defender alerts get" : `defender ${sub}`);

  const profile = profileFromArgs(args);
  if (sub === "alerts") return runAlerts(profile, args);
  if (sub === "assessments") return runAssessments(profile, args);
  return runScore(profile, args);
}
