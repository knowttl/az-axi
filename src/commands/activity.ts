import { AxiError } from "axi-sdk-js";
import { ACTIVITY_LOG, RESOURCE_GRAPH_RESOURCES, SUBSCRIPTIONS_LIST } from "../lib/apiVersions.js";
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
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import { countLine, emptyState, pickFields, shortDate, truncate } from "../lib/format.js";
import type { ResolvedProfile } from "../lib/config.js";
import type { CommandMeta } from "../lib/registry.js";
import { parseSubscriptionId, shortenResourceId, subscriptionNameMap } from "../lib/scope.js";
import { ageDays, parseSince } from "../lib/time.js";

export const meta: CommandMeta = { name: "activity", effect: "read" };

const SUBCOMMANDS = ["list"] as const;
const KNOWN_FLAGS = ["since", "caller", "resource-group", "status", "operation"] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const DEFAULT_SINCE = "24h";
const MAX_SINCE_DAYS = 90;
const CONCURRENCY = 4;
const MAX_PAGES = 20;
const CELL_TRUNCATE = 200;

const SUBSCRIPTIONS_IN_GROUP = [
  "resourcecontainers",
  '| where type =~ "microsoft.resources/subscriptions"',
  "| project subscriptionId, id",
].join("\n");

interface ActivityName {
  value?: string;
  localizedValue?: string;
}

interface ActivityEvent {
  id?: string;
  eventDataId?: string;
  eventTimestamp?: string;
  caller?: string;
  operationName?: ActivityName | string;
  status?: ActivityName | string;
  resourceId?: string;
  resourceGroupName?: string;
  correlationId?: string;
  subscriptionId?: string;
}

interface ActivityListResponse {
  value?: ActivityEvent[];
  nextLink?: string;
}

interface SubFetch {
  subId: string;
  events: ActivityEvent[];
  truncated: boolean;
  error?: unknown;
}

function textsOf(value: ActivityName | string | undefined): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  return [value.value, value.localizedValue].filter((item): item is string => Boolean(item));
}

function textOf(value: ActivityName | string | undefined): string {
  return textsOf(value)[0] ?? "";
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

function eventKey(event: ActivityEvent): string {
  if (event.id) return event.id;
  if (event.eventDataId) return event.eventDataId;
  // correlationId is shared by every event in one operation, so it is not an identity.
  return [
    event.subscriptionId,
    event.eventTimestamp,
    event.caller,
    textOf(event.operationName),
    textOf(event.status),
    event.resourceId,
    event.correlationId,
  ].join("|");
}

function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function activityFilter(startIso: string, endIso: string, resourceGroup?: string): string {
  const parts = [`eventTimestamp ge ${odataString(startIso)} and eventTimestamp le ${odataString(endIso)}`];
  if (resourceGroup) {
    if (/[\r\n]/.test(resourceGroup)) {
      throw new AxiError("flag --resource-group cannot contain newlines", "VALIDATION_ERROR", [
        "Pass the resource group name only",
      ]);
    }
    parts.push(`and resourceGroupName eq ${odataString(resourceGroup)}`);
  }
  return parts.join(" ");
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

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "request failed";
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
  const seenTokens = new Set<string>();
  let skipToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (skipToken) {
      if (seenTokens.has(skipToken)) break;
      seenTokens.add(skipToken);
    }
    const response = await sendRequest<{
      data?: Array<{ subscriptionId?: string; id?: string }>;
      $skipToken?: string;
    }>(profile, {
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
 * Scope order matches `rg query`, except `$AZ_AXI_SUBSCRIPTION` overrides a profile
 * management group. `resolveProfile` copies that env var onto `subscriptions` without
 * clearing `managementGroup`, so the flag and env var have to be read here.
 */
async function resolveSubscriptionIds(
  profile: ResolvedProfile,
  args: ParsedArgs,
): Promise<{ ids: string[]; label: string; narrowed: boolean }> {
  const flagMg = flagText(args, "management-group");
  if (args.flags["subscription"] === true) {
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
    return {
      ids: await subscriptionsInManagementGroup(profile, flagMg),
      label: `in management group ${flagMg}`,
      narrowed: false,
    };
  }
  if (flagSubs?.length) {
    const wanted = new Set(flagSubs.map((id) => id.toLowerCase()));
    const narrowed =
      Boolean(profile.managementGroup) ||
      profile.writeSubscriptions.length === 0 ||
      profile.writeSubscriptions.some((id) => !wanted.has(id.toLowerCase()));
    const ids = uniqueIds(flagSubs);
    return {
      ids,
      label: `for ${ids.length} subscription${ids.length === 1 ? "" : "s"}`,
      narrowed,
    };
  }
  if (envSubs.length > 0) {
    return {
      ids: envSubs,
      label: `for ${envSubs.length} subscription${envSubs.length === 1 ? "" : "s"}`,
      narrowed: false,
    };
  }
  if (profile.managementGroup) {
    return {
      ids: await subscriptionsInManagementGroup(profile, profile.managementGroup),
      label: `in management group ${profile.managementGroup}`,
      narrowed: false,
    };
  }
  if (profile.subscriptions?.length) {
    const ids = uniqueIds(profile.subscriptions);
    return {
      ids,
      label: `for ${ids.length} subscription${ids.length === 1 ? "" : "s"}`,
      narrowed: false,
    };
  }
  const ids = await accessibleSubscriptions(profile);
  return {
    ids,
    label: ids.length === 1 ? "for 1 subscription" : `for ${ids.length} subscriptions`,
    narrowed: false,
  };
}

function matches(
  event: ActivityEvent,
  callerFilter: string | undefined,
  statusFilter: string | undefined,
  operationFilter: string | undefined,
): boolean {
  if (callerFilter && !(event.caller ?? "").toLowerCase().includes(callerFilter)) return false;
  if (statusFilter && !textsOf(event.status).some((text) => text.toLowerCase() === statusFilter)) return false;
  if (operationFilter && !textsOf(event.operationName).some((text) => text.toLowerCase().includes(operationFilter))) {
    return false;
  }
  return true;
}

async function fetchSubscription(
  profile: ResolvedProfile,
  subId: string,
  filter: string,
  target: number,
  callerFilter: string | undefined,
  statusFilter: string | undefined,
  operationFilter: string | undefined,
): Promise<SubFetch> {
  const events: ActivityEvent[] = [];
  const seenEvents = new Set<string>();
  const seenLinks = new Set<string>();
  let path: string | undefined = `/subscriptions/${subId}/providers/Microsoft.Insights/eventtypes/management/values`;
  let firstPage = true;
  let pages = 0;
  let truncated = false;

  try {
    while (path && pages < MAX_PAGES && events.length < target) {
      if (seenLinks.has(path)) {
        truncated = true;
        break;
      }
      seenLinks.add(path);
      const current: string = path;
      // Always pass api-version. The documented nextLink sample has none, and the
      // client refuses an ARM URL that lacks one. `$select` is omitted: the
      // 2015-04-01 allow-list does not include `caller`, which is a default field,
      // and an unsupported select property drops the field or fails the request.
      const query = firstPage ? { $filter: filter } : undefined;
      const response: ApiResponse<ActivityListResponse> = await sendRequest<ActivityListResponse>(profile, {
        method: "GET",
        path: current,
        apiVersion: ACTIVITY_LOG,
        query,
      });
      firstPage = false;
      pages++;
      const page = Array.isArray(response.body?.value) ? response.body.value : [];
      for (const event of page) {
        const stamped = { ...event, subscriptionId: subId };
        if (!matches(stamped, callerFilter, statusFilter, operationFilter)) continue;
        const key = eventKey(stamped);
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
        events.push(stamped);
        if (events.length >= target) break;
      }
      const next: string | undefined = response.body?.nextLink;
      if (!next || events.length >= target) {
        path = undefined;
        break;
      }
      path = next;
    }
    if (path && events.length < target) truncated = true;
    return { subId, events, truncated };
  } catch (err) {
    return { subId, events, truncated, error: err };
  }
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  subcommandOf(args, SUBCOMMANDS, "activity");
  assertKnownFlags(args, KNOWN_FLAGS, "activity list");
  if (args.positionals.length > 1) {
    throw new AxiError(`unexpected argument \`${args.positionals[1]}\` for \`activity list\``, "VALIDATION_ERROR", [
      "Run `az-axi activity list --help` for usage",
    ]);
  }
  if (args.flags["limit"] === true) {
    throw new AxiError("flag --limit needs a number", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }

  const profile = profileFromArgs(args);
  const full = flagBool(args, "full");
  const limit = full ? Number.POSITIVE_INFINITY : (flagNumber(args, "limit") ?? DEFAULT_LIMIT);
  if (!(limit > 0)) {
    throw new AxiError("flag --limit must be greater than 0", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }
  if (limit !== Number.POSITIVE_INFINITY && limit > MAX_LIMIT) {
    throw new AxiError(`flag --limit must be at most ${MAX_LIMIT}`, "VALIDATION_ERROR", [
      `Example: --limit ${MAX_LIMIT}`,
    ]);
  }
  const fields = flagList(args, "fields");

  const sinceRaw = flagText(args, "since") ?? DEFAULT_SINCE;
  const now = new Date();
  const start = parseSince(sinceRaw, now);
  if (ageDays(start, now) > MAX_SINCE_DAYS) {
    throw new AxiError(`the activity log retains only 90 days (--since ${sinceRaw} is too far back)`, "VALIDATION_ERROR", [
      "Query the AzureActivity table instead: `az-axi logs query \"AzureActivity | take 5\" --workspace <alias>`",
      "Use --since 90d or less for `activity list`",
    ]);
  }
  const startIso = start.toISOString();
  const endIso = now.toISOString();

  const callerFilter = flagText(args, "caller")?.toLowerCase();
  const rgFilter = flagText(args, "resource-group");
  const statusFilter = flagText(args, "status")?.toLowerCase();
  const operationFilter = flagText(args, "operation")?.toLowerCase();
  const filter = activityFilter(startIso, endIso, rgFilter);

  const scope = await resolveSubscriptionIds(profile, args);
  const scopeHint = `${scope.label} since ${sinceRaw}`;

  if (scope.ids.length === 0) {
    return {
      profile: profile.name,
      total: 0,
      count: countLine(0, 0, "events"),
      rows: emptyState("activity events", scopeHint),
      help: ["Run `az-axi sub list` to verify the subscriptions in scope"],
    };
  }

  const target = limit === Number.POSITIVE_INFINITY ? MAX_LIMIT : limit;
  const fetched = await mapPool(scope.ids, CONCURRENCY, (subId) =>
    fetchSubscription(profile, subId, filter, target, callerFilter, statusFilter, operationFilter),
  );

  const failures = fetched.filter((item) => item.error);
  const collected = fetched.flatMap((item) => item.events);
  if (collected.length === 0 && failures.length > 0) {
    const err = failures[0]?.error;
    if (err instanceof Error) throw err;
    throw new AxiError("activity log query failed", "API_ERROR", failures.map((item) => errorText(item.error)));
  }

  collected.sort((a, b) => eventTime(b.eventTimestamp) - eventTime(a.eventTimestamp));
  const truncated = fetched.some((item) => item.truncated);

  if (collected.length === 0) {
    const help = [
      "Widen the window with --since 7d",
      "Run `az-axi activity list --since 24h --status Failed` for recent failures",
    ];
    if (scope.narrowed) help.push("Omit --subscription to include every subscription in scope");
    return {
      profile: profile.name,
      total: 0,
      count: countLine(0, 0, "events"),
      rows: emptyState("activity events", scopeHint),
      help: help.slice(0, 3),
    };
  }

  const topCallers: Record<string, number> = {};
  for (const event of collected) {
    const caller = event.caller || "(unknown)";
    topCallers[caller] = (topCallers[caller] ?? 0) + 1;
  }
  const top5 = Object.fromEntries(Object.entries(topCallers).sort(([, a], [, b]) => b - a).slice(0, 5));

  const names = full ? undefined : await subscriptionNameMap(profile);
  const extended = collected.map((event) => ({
    time: shortDate(event.eventTimestamp),
    caller: formatCell(event.caller ?? "", full),
    operation: formatCell(textOf(event.operationName), full),
    status: formatCell(textOf(event.status), full),
    resource: formatCell(full ? (event.resourceId ?? "") : shortenResourceId(event.resourceId ?? "", names), full),
    resourceGroup: formatCell(event.resourceGroupName ?? "", full),
    subscription: formatCell(event.subscriptionId ?? "", full),
    correlationId: formatCell(event.correlationId ?? "", full),
  }));

  const shown = full ? extended : extended.slice(0, limit);
  const picked = fields
    ? pickFields(shown, fields)
    : pickFields(shown, ["time", "caller", "operation", "status", "resource"]);

  const help: string[] = [];
  if (failures.length > 0) {
    const first = failures[0];
    const listed = failures
      .slice(0, 3)
      .map((item) => item.subId)
      .join(", ");
    help.push(
      `Could not query ${failures.length} subscription${failures.length === 1 ? "" : "s"} (${listed}: ${errorText(first?.error)})`,
    );
  }
  if (truncated) {
    help.push("Stopped before every matching event was collected; narrow --since or add --resource-group");
  }
  if (!statusFilter && collected.some((event) => textsOf(event.status).some((text) => text.toLowerCase() === "failed"))) {
    help.push("Run `az-axi activity list --since 24h --status Failed` for recent failures");
  }
  if (scope.narrowed) help.push("Omit --subscription to include every subscription in scope");
  if (flagText(args, "management-group") && flagList(args, "subscription")?.length) {
    help.push("--subscription is ignored when --management-group is set");
  }

  return {
    profile: profile.name,
    total: collected.length,
    count: countLine(shown.length, collected.length, "events"),
    topCallers: top5,
    rows: picked,
    ...(help.length > 0 ? { help: help.slice(0, 3) } : {}),
  };
}
