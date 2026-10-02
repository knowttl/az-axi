import { AxiError } from "axi-sdk-js";
import { ACTIVITY_LOG, SUBSCRIPTIONS_LIST } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { requestAll, sendRequest, type ApiResponse } from "../lib/client.js";
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import { countLine, emptyState, pickFields, shortDate, truncate } from "../lib/format.js";
import type { CommandMeta } from "../lib/registry.js";
import { shortenResourceId, subscriptionNameMap } from "../lib/scope.js";
import { ageDays, parseSince } from "../lib/time.js";

export const meta: CommandMeta = { name: "activity", effect: "read" };

const SUBCOMMANDS = ["list"] as const;
const KNOWN_FLAGS = ["since", "caller", "resource-group", "status", "operation"] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const DEFAULT_SINCE = "24h";
const MAX_SINCE_DAYS = 90;
const CONCURRENCY = 4;
const CELL_TRUNCATE = 200;

interface ActivityName {
  value?: string;
  localizedValue?: string;
}

interface ActivityEvent {
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

function textOf(value: ActivityName | string | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.value ?? value.localizedValue ?? "";
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

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  subcommandOf(args, SUBCOMMANDS, "activity");
  assertKnownFlags(args, KNOWN_FLAGS, "activity list");
  if (args.positionals.length > 1) {
    throw new AxiError(`unexpected argument \`${args.positionals[1]}\` for \`activity list\``, "VALIDATION_ERROR", [
      "Run `az-axi activity list --help` for usage",
    ]);
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

  const sinceRaw = flagString(args, "since") ?? DEFAULT_SINCE;
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

  const callerFilter = flagString(args, "caller")?.toLowerCase();
  const rgFilter = flagString(args, "resource-group");
  const statusFilter = flagString(args, "status")?.toLowerCase();
  const operationFilter = flagString(args, "operation")?.toLowerCase();

  const flagSubs = flagList(args, "subscription");
  let subscriptionIds: string[];
  if (flagSubs?.length) {
    subscriptionIds = flagSubs;
  } else if (profile.subscriptions?.length) {
    subscriptionIds = profile.subscriptions;
  } else {
    const { items } = await requestAll<{ subscriptionId: string }>(
      profile,
      { path: "/subscriptions", apiVersion: SUBSCRIPTIONS_LIST },
      100,
    );
    subscriptionIds = items.map((sub) => sub.subscriptionId).filter(Boolean);
  }

  const scopeHint =
    subscriptionIds.length === 1
      ? `for 1 subscription in the last ${sinceRaw}`
      : `for ${subscriptionIds.length} subscriptions in the last ${sinceRaw}`;

  if (subscriptionIds.length === 0) {
    return {
      profile: profile.name,
      total: 0,
      count: countLine(0, 0, "events"),
      rows: emptyState("activity events", "visible to this identity"),
      help: ["Run `az-axi sub list` to verify the subscriptions in scope"],
    };
  }

  const perSubCap = limit === Number.POSITIVE_INFINITY ? MAX_LIMIT : limit;
  const filterParts = [`eventTimestamp ge '${startIso}' and eventTimestamp le '${endIso}'`];
  if (rgFilter) filterParts.push(`and resourceGroupName eq '${rgFilter.replace(/'/g, "''")}'`);

  const collected: ActivityEvent[] = [];
  const queue = [...subscriptionIds];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const subId = queue.shift() as string;
      let path: string | undefined = `/subscriptions/${subId}/providers/Microsoft.Insights/eventtypes/management/values`;
      let firstPage = true;
      let fetched = 0;
      while (path && fetched < perSubCap) {
        const currentPath: string = path;
        const currentQuery: Record<string, string> | undefined = firstPage
          ? {
              "$filter": filterParts.join(" "),
              "$select": "eventTimestamp,caller,operationName,status,resourceId,resourceGroupName,correlationId",
            }
          : undefined;
        firstPage = false;
        const response: ApiResponse<ActivityListResponse> = await sendRequest<ActivityListResponse>(profile, {
          method: "GET",
          path: currentPath,
          query: currentQuery,
          ...(currentQuery ? { apiVersion: ACTIVITY_LOG } : {}),
        });
        const page = response.body?.value ?? [];
        for (const event of page) {
          collected.push({ ...event, subscriptionId: event.subscriptionId ?? subId });
        }
        fetched += page.length;
        path = response.body?.nextLink;
        if (page.length === 0) break;
      }
    }
  });
  await Promise.all(workers);

  let filtered = collected;
  if (callerFilter) {
    filtered = filtered.filter((event) => (event.caller ?? "").toLowerCase().includes(callerFilter));
  }
  if (statusFilter) {
    filtered = filtered.filter((event) => textOf(event.status).toLowerCase() === statusFilter);
  }
  if (operationFilter) {
    filtered = filtered.filter((event) =>
      textOf(event.operationName).toLowerCase().includes(operationFilter),
    );
  }

  filtered.sort((a, b) => eventTime(b.eventTimestamp) - eventTime(a.eventTimestamp));

  if (filtered.length === 0) {
    return {
      profile: profile.name,
      total: 0,
      count: countLine(0, 0, "events"),
      rows: emptyState("activity events", scopeHint),
      help: [
        "Widen the window with --since 7d",
        "Run `az-axi activity list --since 24h --status Failed` for recent failures",
      ],
    };
  }

  const topCallers: Record<string, number> = {};
  for (const event of filtered) {
    const caller = event.caller || "(unknown)";
    topCallers[caller] = (topCallers[caller] ?? 0) + 1;
  }
  const top5 = Object.fromEntries(Object.entries(topCallers).sort(([, a], [, b]) => b - a).slice(0, 5));

  const names = full ? undefined : await subscriptionNameMap(profile);
  const extended = filtered.map((event) => ({
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
  if (!statusFilter && filtered.some((event) => textOf(event.status).toLowerCase() === "failed")) {
    help.push("Run `az-axi activity list --since 24h --status Failed` for recent failures");
  }
  if (subscriptionIds.length > 1 && flagSubs?.length) {
    help.push("Omit --subscription to merge across every subscription in scope");
  }

  return {
    profile: profile.name,
    total: filtered.length,
    count: countLine(shown.length, filtered.length, "events"),
    topCallers: top5,
    rows: picked,
    ...(help.length > 0 ? { help } : {}),
  };
}
