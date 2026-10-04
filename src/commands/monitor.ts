import { AxiError } from "axi-sdk-js";
import { ACTION_GROUPS, DIAGNOSTIC_SETTINGS, METRIC_ALERTS, MONITOR_METRICS } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagText, parseArgs, type ParsedArgs } from "../lib/args.js";
import { request, requestAll } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import { runDiscovery, subscriptions } from "../lib/discovery.js";
import { countLine, emptyState, pickFields, truncate } from "../lib/format.js";
import {
  arrOf,
  governanceSegment,
  objOf,
  runGovernanceList,
  runGovernanceShow,
  str,
  strArr,
  tailName,
  type AnyObj,
  type GovernanceCollection,
  type GovernanceItem,
} from "../lib/governance.js";
import { monitorLeafHelp } from "../lib/monitorHelp.js";
import { redact } from "../lib/redact.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { parseSubscriptionId, shortenResourceId } from "../lib/scope.js";
import { formatFlagValue } from "../lib/shell.js";

export const meta = commandMeta("monitor");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const CELL_TRUNCATE = 200;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const AGGREGATIONS = ["Average", "Minimum", "Maximum", "Total", "Count"];

function invalid(message: string, path: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", [monitorLeafHelp(path)]);
}

function joined(values: Array<string | number>, full: boolean): string {
  const text = values.map(String).filter(Boolean).join(", ");
  return full ? text : truncate(text, CELL_TRUNCATE).text;
}

function limitValue(args: ParsedArgs, path: string): number {
  if (args.flags["limit"] === true || args.flags["limit"] === "") {
    invalid("flag --limit needs a number", path);
  }
  const limit = flagNumber(args, "limit") ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) invalid("--limit must be a positive integer", path);
  if (limit > MAX_LIMIT) invalid(`--limit must be at most ${MAX_LIMIT}`, path);
  return limit;
}

/** One ARM ID under /subscriptions/<guid>, the shared target shape for
 * resource-scoped Monitor reads (diagnostic settings, metrics). */
function resourceScope(value: string | undefined, flag: string, path: string): string {
  if (!value || /[\u0000-\u001f\u007f?#%\\]/.test(value)) {
    invalid(`--${flag} must be one ARM resource, resource-group or subscription ID`, path);
  }
  const id = value.trim();
  if (id.split("/").some((segment) => segment === "." || segment === "..")) {
    invalid(`--${flag} must not contain dot segments`, path);
  }
  const match = /^\/subscriptions\/([^/]+)(\/.*)?$/i.exec(id);
  if (!match || !GUID.test(match[1]!)) {
    invalid(`--${flag} must be one ARM ID under /subscriptions/<id>`, path);
  }
  return id;
}

function scopeLabel(count: number, resource: string): string {
  return `for ${shortenResourceId(resource)} in ${count} subscription${count === 1 ? "" : "s"}`;
}

async function resourceSubscriptions(profile: ReturnType<typeof profileFromArgs>, resource: string, path: string): Promise<string[]> {
  const selected = await subscriptions(profile);
  const subscription = parseSubscriptionId(resource)!;
  if (!selected.some((id) => id.toLowerCase() === subscription.toLowerCase())) {
    invalid("--resource conflicts with selected subscriptions", path);
  }
  return selected;
}

/** `Metric criterion: operator threshold`, tolerating dynamic and webtest shapes. */
function criterionSummary(criterion: AnyObj): string {
  const metric = str(criterion.metricName) || str(criterion.metricNamespace) || str(criterion.componentId);
  const operator = str(criterion.operator) || (str(criterion.alertSensitivity) ? `Dynamic(${criterion.alertSensitivity})` : "");
  const periods = objOf(criterion.failingPeriods);
  const threshold = criterion.threshold ?? (criterion.failingPeriods
    ? `${periods.minFailingPeriodsToAlert} failing of ${periods.numberOfEvaluationPeriods} evaluation periods` : "");
  return [metric, operator, String(threshold)].filter(Boolean).join(" ");
}

function alertCriteria(props: AnyObj): string[] {
  const criteria = objOf(props.criteria);
  const allOf = Array.isArray(criteria.allOf) ? criteria.allOf : [];
  return (allOf as AnyObj[]).map(criterionSummary).filter(Boolean);
}

const METRIC_ALERT: GovernanceCollection = {
  words: ["metrics", "alert"],
  top: "monitor",
  noun: "metric alert rules",
  arm: "metricAlerts",
  apiVersion: METRIC_ALERTS,
  idTail: /^\/subscriptions\/[^/]+(\/resourceGroups\/[^/]+)?\/providers\/Microsoft\.Insights\/metricAlerts\/[^/]+$/i,
  listTargets: (subscription, group) => [
    {
      method: "GET",
      path: `/subscriptions/${subscription}${group ? `/resourceGroups/${group}` : ""}/providers/Microsoft.Insights/metricAlerts`,
      apiVersion: METRIC_ALERTS,
    },
  ],
  compact: (item, full) => {
    const props = objOf(item.properties);
    return {
      name: item.name,
      severity: props.severity ?? "",
      enabled: props.enabled ?? "",
      scopes: joined(strArr(props.scopes).map(tailName), full),
      criteria: joined(alertCriteria(props), full),
    };
  },
  fields: ["name", "severity", "enabled", "scopes", "criteria"],
  detail: (item, full, _limit) => {
    const props = objOf(item.properties);
    const description = str(props.description);
    const actions = arrOf(props.actions);
    return {
      body: {
        name: item.name,
        id: item.id,
        description: full ? description : truncate(description, CELL_TRUNCATE).text,
        severity: props.severity ?? "",
        enabled: props.enabled ?? "",
        scopes: full ? strArr(props.scopes) : [joined(strArr(props.scopes).map(tailName), full)],
        frequency: str(props.evaluationFrequency),
        window: str(props.windowSize),
        criteria: full
          ? (alertCriteria(props).length ? alertCriteria(props) : ["(dynamic or webtest criteria; see rule JSON)"])
          : [joined(alertCriteria(props), full)],
        // Webhook property values can carry tokens, so only names are shown.
        actions: full
          ? actions.map((action) => ({
            group: str(action.actionGroupId),
            webhookKeys: Object.keys(objOf(action.webHookProperties)),
          }))
          : [joined(actions.map((action) => tailName(str(action.actionGroupId)) || "webhook"), full)],
      },
    };
  },
  aggregate: (items) => {
    const bySeverity: Record<string, number> = {};
    const byEnabled: Record<string, number> = {};
    for (const item of items) {
      const props = objOf(item.properties);
      const severity = props.severity === undefined || props.severity === "" ? "(unknown)" : String(props.severity);
      const enabled = props.enabled === undefined || props.enabled === "" ? "(unknown)" : String(props.enabled);
      bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
      byEnabled[enabled] = (byEnabled[enabled] ?? 0) + 1;
    }
    return { bySeverity, byEnabled };
  },
};

/** `email:2, webhook:1` from the receiver collections, or `none`. */
function receiverSummary(props: AnyObj): string {
  const kinds: Array<[string, unknown]> = [
    ["email", props.emailReceivers], ["sms", props.smsReceivers], ["webhook", props.webhookReceivers],
    ["itsm", props.itsmReceivers], ["automation", props.automationRunbookReceivers], ["voice", props.voiceReceivers],
    ["logicApp", props.logicAppReceivers], ["eventHub", props.eventHubReceivers], ["armRole", props.armRoleReceivers],
    ["appPush", props.azureAppPushReceivers], ["function", props.azureFunctionReceivers],
  ];
  const parts = kinds.flatMap(([label, value]) => {
    const count = arrOf(value).length;
    return count ? [`${label}:${count}`] : [];
  });
  return parts.join(", ") || "none";
}

function receiverDetails(props: AnyObj): AnyObj[] {
  const details: AnyObj[] = [];
  for (const entry of arrOf(props.emailReceivers)) {
    details.push({ type: "email", name: str(entry.name), address: str(entry.emailAddress) });
  }
  for (const entry of arrOf(props.smsReceivers)) {
    details.push({ type: "sms", name: str(entry.name), country: str(entry.countryCode), number: str(entry.phoneNumber) });
  }
  for (const entry of arrOf(props.webhookReceivers)) {
    details.push({ type: "webhook", name: str(entry.name), uri: str(entry.serviceUri).split(/[?#]/, 1)[0] ?? "",
      properties: Object.keys(objOf(entry.properties)) });
  }
  for (const entry of arrOf(props.itsmReceivers)) {
    details.push({ type: "itsm", name: str(entry.name), workspace: str(entry.workspaceId),
      connection: str(entry.connectionId), region: str(entry.region) });
  }
  for (const entry of arrOf(props.automationRunbookReceivers)) {
    details.push({ type: "automation", name: str(entry.name), account: str(entry.automationAccountId),
      runbook: str(entry.runbookName), webhook: str(entry.webhookResourceId) });
  }
  for (const entry of arrOf(props.voiceReceivers)) {
    details.push({ type: "voice", name: str(entry.name), country: str(entry.countryCode), number: str(entry.phoneNumber) });
  }
  for (const entry of arrOf(props.logicAppReceivers)) {
    details.push({ type: "logicApp", name: str(entry.name), resource: str(entry.resourceId) });
  }
  for (const entry of arrOf(props.eventHubReceivers)) {
    details.push({ type: "eventHub", name: str(entry.name), namespace: str(entry.eventHubNameSpace),
      hub: str(entry.eventHubName), subscription: str(entry.subscriptionId) });
  }
  for (const entry of arrOf(props.armRoleReceivers)) {
    details.push({ type: "armRole", name: str(entry.name), role: str(entry.roleId) });
  }
  for (const entry of arrOf(props.azureAppPushReceivers)) {
    details.push({ type: "azureAppPush", name: str(entry.name), address: str(entry.emailAddress) });
  }
  for (const entry of arrOf(props.azureFunctionReceivers)) {
    details.push({ type: "function", name: str(entry.name), app: str(entry.functionAppResourceId),
      function: str(entry.functionName) });
  }
  return details;
}

const ACTION_GROUP: GovernanceCollection = {
  words: ["action-group"],
  top: "monitor",
  noun: "action groups",
  arm: "actionGroups",
  apiVersion: ACTION_GROUPS,
  idTail: /^\/subscriptions\/[^/]+(\/resourceGroups\/[^/]+)?\/providers\/Microsoft\.Insights\/actionGroups\/[^/]+$/i,
  listTargets: (subscription, group) => [
    {
      method: "GET",
      path: `/subscriptions/${subscription}${group ? `/resourceGroups/${group}` : ""}/providers/Microsoft.Insights/actionGroups`,
      apiVersion: ACTION_GROUPS,
    },
  ],
  compact: (item, full) => {
    const props = objOf(item.properties);
    return {
      name: item.name,
      enabled: props.enabled ?? "",
      shortName: full ? str(props.groupShortName) : truncate(str(props.groupShortName), CELL_TRUNCATE).text,
      receivers: receiverSummary(props),
    };
  },
  fields: ["name", "enabled", "shortName", "receivers"],
  detail: (item, full, _limit) => {
    const props = objOf(item.properties);
    const receivers = receiverDetails(props);
    return {
      body: {
        name: item.name,
        id: item.id,
        shortName: str(props.groupShortName),
        enabled: props.enabled ?? "",
        receivers: full ? receivers : [receiverSummary(props)],
      },
    };
  },
  aggregate: (items) => {
    const byEnabled: Record<string, number> = {};
    let receivers = 0;
    for (const item of items) {
      const props = objOf(item.properties);
      const enabled = props.enabled === undefined || props.enabled === "" ? "(unknown)" : String(props.enabled);
      byEnabled[enabled] = (byEnabled[enabled] ?? 0) + 1;
      receivers += receiverDetails(props).length;
    }
    return { byEnabled, receivers };
  },
};

const READ_COLLECTIONS: GovernanceCollection[] = [METRIC_ALERT, ACTION_GROUP];

function showPath(collection: GovernanceCollection, subscription: string, group: string | undefined, name: string, path: string): string {
  if (!group) invalid(`${path} by name needs --resource-group`, path);
  return `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.Insights/${collection.arm}/${name}`;
}

interface DiagnosticSetting extends Record<string, unknown> {
  id: string;
  name: string;
}

function categorySummary(categories: unknown): string {
  const enabled = arrOf(categories).filter((entry) => entry.enabled === true)
    .map((entry) => str(entry.category) || str(entry.categoryGroup));
  return enabled.length ? `${enabled.join(", ")} (${enabled.length} enabled)` : "none enabled";
}

function destinationsOf(props: AnyObj): string {
  const parts = [
    props.storageAccountId !== undefined && str(props.storageAccountId) ? `storage:${tailName(str(props.storageAccountId))}` : "",
    props.workspaceId !== undefined && str(props.workspaceId) ? `workspace:${tailName(str(props.workspaceId))}` : "",
    props.eventHubAuthorizationRuleId !== undefined && str(props.eventHubAuthorizationRuleId)
      ? `eventHub:${tailName(str(props.eventHubAuthorizationRuleId))}` : "",
    props.eventHubName !== undefined && str(props.eventHubName) ? `hub:${str(props.eventHubName)}` : "",
    props.marketplacePartnerId !== undefined && str(props.marketplacePartnerId) ? "partner" : "",
  ].filter(Boolean);
  return parts.join(", ") || "none";
}

function settingRow(item: DiagnosticSetting, full: boolean): AnyObj {
  const props = redact(objOf(item.properties));
  return {
    name: item.name,
    logs: full ? arrOf(props.logs).map((entry) => ({
      category: str(entry.category), categoryGroup: str(entry.categoryGroup), enabled: entry.enabled ?? "",
      retentionDays: entry.retentionPolicy !== undefined && typeof entry.retentionPolicy === "object"
        ? (entry.retentionPolicy as AnyObj).days ?? "" : "",
    })) : categorySummary(props.logs),
    metrics: full ? arrOf(props.metrics).map((entry) => ({
      category: str(entry.category), categoryGroup: str(entry.categoryGroup), enabled: entry.enabled ?? "",
      retentionDays: entry.retentionPolicy !== undefined && typeof entry.retentionPolicy === "object"
        ? (entry.retentionPolicy as AnyObj).days ?? "" : "",
    })) : categorySummary(props.metrics),
    destinations: full
      ? { storage: str(props.storageAccountId), workspace: str(props.workspaceId),
        eventHubRule: str(props.eventHubAuthorizationRuleId), eventHub: str(props.eventHubName),
        partner: str(props.marketplacePartnerId) }
      : destinationsOf(props),
  };
}

const SETTING_FIELDS = ["name", "logs", "metrics", "destinations"];
const SETTING_SHOW_FIELDS = ["name", "id", "logs", "metrics", "storage", "workspace", "eventHub", "partner"];

async function runDiagnosticSettingsList(
  profile: ReturnType<typeof profileFromArgs>,
  args: ParsedArgs,
  path: string,
): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !SETTING_FIELDS.includes(field))) {
    invalid(`${path} --fields supports only: ${SETTING_FIELDS.join(", ")}`, path);
  }
  const limit = limitValue(args, path);
  const resource = resourceScope(flagText(args, "resource"), "resource", path);
  const subs = await resourceSubscriptions(profile, resource, path);
  const scopeSuffix = ["profile", "config", "tenant", "subscription"]
    .filter((key) => typeof args.flags[key] === "string")
    .map((key) => ` ${formatFlagValue(key, args.flags[key] as string)}`).join("");
  const suffix = `${scopeSuffix} ${formatFlagValue("resource", resource)}`;
  const fetched = redact(await requestAll<DiagnosticSetting>(profile,
    { method: "GET", path: `${resource}/providers/Microsoft.Insights/diagnosticSettings`, apiVersion: DIAGNOSTIC_SETTINGS }, 100));
  const items = fetched.items;
  const total = fetched.nextLink ? `${items.length}+` : items.length;
  const pagingHelp = fetched.nextLink
    ? ["More pages exist; paging stopped early. Counts are lower bounds. Narrow the target resource."] : [];
  const context = scopeLabel(subs.length, resource);
  if (items.length === 0) {
    return {
      profile: profile.name,
      total,
      count: fetched.nextLink ? `0 of ${total} diagnostic settings` : countLine(0, 0, "diagnostic settings"),
      rows: emptyState("diagnostic settings", fetched.nextLink ? `${context} in fetched pages; listing is incomplete` : context),
      help: [`Run \`az-axi ${path}${suffix} --full\` to show every fetched row`, ...pagingHelp],
    };
  }
  const displayed = full ? items : items.slice(0, limit);
  const shown = displayed.map((item) => settingRow(item, full));
  const picked = pickFields(shown, fields);
  const help: string[] = [
    `Run \`az-axi monitor diagnostic-settings show ${formatFlagValue("ids", items[0]!.id)}${scopeSuffix}\` for the first row in detail`,
  ];
  if (shown.length < items.length) {
    help.push(`Run \`az-axi ${path}${suffix} --full\` to show every fetched row`);
  }
  help.push(...pagingHelp);
  return {
    profile: profile.name,
    total,
    count: fetched.nextLink ? `${shown.length} of ${total} diagnostic settings` : countLine(shown.length, items.length, "diagnostic settings"),
    rows: picked,
    help,
  };
}

async function runDiagnosticSettingsShow(
  profile: ReturnType<typeof profileFromArgs>,
  args: ParsedArgs,
  path: string,
): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !SETTING_SHOW_FIELDS.includes(field))) {
    invalid(`${path} --fields supports only: ${SETTING_SHOW_FIELDS.join(", ")}`, path);
  }
  const name = flagText(args, "name");
  const resource = flagText(args, "resource");
  const ids = flagText(args, "ids");
  if (name && ids) invalid(`${path} takes --name or --ids, not both`, path);
  if (resource && ids) invalid("--ids selects the setting itself; --resource is not accepted with --ids", path);
  if (!name && !ids) invalid(`${path} needs --resource with --name, or --ids <setting-ARM-id>`, path);
  const suffix = ["profile", "config", "tenant", "subscription", "resource", "name", "ids"]
    .filter((key) => typeof args.flags[key] === "string")
    .map((key) => ` ${formatFlagValue(key, args.flags[key] as string)}`).join("");
  let getPath: string;
  let subscription: string;
  if (ids) {
    const id = resourceScope(ids, "ids", path);
    const match = /^\/subscriptions\/([^/]+)(\/.*)?\/providers\/Microsoft\.Insights\/diagnosticSettings\/([^/]+)$/i.exec(id);
    if (!match) {
      invalid("--ids must be one diagnostic-setting ARM ID .../providers/Microsoft.Insights/diagnosticSettings/<name>", path);
    }
    getPath = id;
    subscription = match[1]!;
    const selected = profile.subscriptions?.length ? await subscriptions(profile) : [subscription];
    if (!selected.some((selectedId) => selectedId.toLowerCase() === subscription.toLowerCase())) {
      invalid("--ids conflicts with selected subscriptions", path);
    }
  } else {
    const scope = resourceScope(resource, "resource", path);
    const selected = await resourceSubscriptions(profile, scope, path);
    if (selected.length !== 1) invalid(`${path} by name needs exactly one subscription; use --subscription <id>`, path);
    subscription = selected[0]!;
    getPath = `${scope}/providers/Microsoft.Insights/diagnosticSettings/${governanceSegment(name!, "name", path)}`;
  }
  const item = redact(await request<DiagnosticSetting>(profile,
    { method: "GET", path: getPath, apiVersion: DIAGNOSTIC_SETTINGS }));
  const props = objOf(item.properties);
  const row = settingRow(item, true);
  const body = {
    name: item.name,
    id: item.id,
    logs: row.logs,
    metrics: row.metrics,
    storage: str(props.storageAccountId),
    workspace: str(props.workspaceId),
    eventHub: [str(props.eventHubAuthorizationRuleId), str(props.eventHubName)].filter(Boolean).join(" "),
    partner: str(props.marketplacePartnerId),
  };
  const compact = settingRow(item, false);
  const shortened = !full && JSON.stringify(pickFields([{ ...compact }], fields)) !==
    JSON.stringify(pickFields([{ name: body.name, logs: body.logs, metrics: body.metrics,
      destinations: destinationsOf(props) }], fields));
  const help: string[] = [];
  if (shortened) {
    help.push(`Run \`az-axi ${path}${suffix} --full\` for every nested row`);
  }
  const picked = pickFields([{ ...body, profile: profile.name,
    subscription: parseSubscriptionId(item.id ?? "") ?? subscription }], fields)[0]!;
  return { profile: profile.name, ...picked, ...(help.length > 0 ? { help } : {}) };
}

interface MetricDefinition extends Record<string, unknown> {
  name?: { value?: string };
}

/** Display name of a metric definition or value entry. */
function metricNameOf(entry: AnyObj): string {
  return typeof entry.name === "object" && entry.name !== null
    ? str((entry.name as AnyObj).value) : str(entry.name);
}

interface MetricValue extends Record<string, unknown> {
  name?: { value?: string };
  unit?: string;
  errorCode?: string;
  errorMessage?: string;
  timeseries?: Array<{ data?: Array<Record<string, unknown>> }>;
}

function parseInstant(value: string | undefined, flag: string, path: string): number | undefined {
  if (value === undefined) return undefined;
  const date = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const year = Number(date?.[1]);
  const month = Number(date?.[2]);
  const day = Number(date?.[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  const instant = Date.parse(value);
  if (!date || day < 1 || day > days || !Number.isFinite(instant)) {
    invalid(`--${flag} must be an ISO 8601 datetime, for example 2026-10-01T00:00:00Z`, path);
  }
  return instant;
}

function datumValues(datum: Record<string, unknown>): Record<string, number> {
  const values: Record<string, number> = {};
  for (const aggregation of AGGREGATIONS) {
    const key = aggregation.toLowerCase();
    if (typeof datum[key] === "number") values[key] = datum[key];
  }
  return values;
}

async function runMetricsList(
  profile: ReturnType<typeof profileFromArgs>,
  args: ParsedArgs,
  path: string,
): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !["metric", "unit", "aggregations", "points", "latest", "time", "from", "to"].includes(field))) {
    invalid(`${path} --fields supports only: metric, unit, aggregations, points, latest, time, from, to`, path);
  }
  const limit = limitValue(args, path);
  const resource = resourceScope(flagText(args, "resource"), "resource", path);
  if (/^\/subscriptions\/[^/]+$/i.test(resource)) {
    invalid("--resource must target one resource; subscription-scope metrics stay out", path);
  }
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
    invalid("management-group scope is unsupported for Monitor reads; select subscriptions explicitly", path);
  }
  const metricNames = flagList(args, "metric");
  if (metricNames !== undefined && metricNames.length === 0) invalid("flag --metric needs a non-empty value", path);
  const aggregationNames = flagList(args, "aggregation");
  const aggregations = aggregationNames?.map((name) => {
    const canonical = AGGREGATIONS.find((allowed) => allowed.toLowerCase() === name.toLowerCase());
    if (!canonical) invalid(`--aggregation supports only: ${AGGREGATIONS.join(", ")}`, path);
    return canonical!;
  });
  const interval = flagText(args, "interval");
  const end = parseInstant(flagText(args, "end-time"), "end-time", path) ?? Date.now();
  const start = parseInstant(flagText(args, "start-time"), "start-time", path) ?? end - 60 * 60 * 1000;
  if (!(start < end)) invalid("--start-time must be earlier than --end-time", path);
  if (end - start > MAX_WINDOW_MS) invalid("--start-time to --end-time must span at most 31 days", path);
  const from = new Date(start).toISOString();
  const to = new Date(end).toISOString();
  const subs = await resourceSubscriptions(profile, resource, path);
  const suffix = ["profile", "config", "tenant", "subscription", "resource"]
    .filter((key) => typeof args.flags[key] === "string")
    .map((key) => ` ${formatFlagValue(key, args.flags[key] as string)}`).join("");
  const querySuffix = `${formatFlagValue("start-time", from)} ${formatFlagValue("end-time", to)}` +
    ["interval", "aggregation"].filter((key) => typeof args.flags[key] === "string")
      .map((key) => ` ${formatFlagValue(key, args.flags[key] as string)}`).join("");

  if (!metricNames?.length) {
    const fetched = redact(await requestAll<MetricDefinition>(profile,
      { method: "GET", path: `${resource}/providers/Microsoft.Insights/metricDefinitions`, apiVersion: MONITOR_METRICS }, 100));
    const definitions = fetched.items;
    const total = fetched.nextLink ? `${definitions.length}+` : definitions.length;
    const pagingHelp = fetched.nextLink
      ? ["More pages exist; paging stopped early. Counts are lower bounds. Narrow the target resource."] : [];
    const context = scopeLabel(subs.length, resource);
    if (definitions.length === 0) {
      return {
        profile: profile.name,
        total,
        count: fetched.nextLink ? `0 of ${total} metric definitions` : countLine(0, 0, "metric definitions"),
        rows: emptyState("metric definitions", fetched.nextLink ? `${context} in fetched pages; listing is incomplete` : context),
        help: [`Run \`az-axi ${path}${suffix} --full\` to show every fetched row`, ...pagingHelp],
      };
    }
    const displayed = full ? definitions : definitions.slice(0, limit);
    const shown = displayed.map((definition) => {
      const props = objOf(definition);
      const name = metricNameOf(definition);
      return {
        metric: full ? name : truncate(name, CELL_TRUNCATE).text,
        unit: str(props.unit),
        aggregations: joined(strArr(props.supportedAggregationTypes), full),
      };
    });
    const picked = pickFields(shown, fields);
    const help = [
      `Run \`az-axi ${path}${suffix} ${formatFlagValue("metric", metricNameOf(displayed[0]!))} ${querySuffix} --full\` for values of the first metric`,
    ];
    if (shown.length < definitions.length) {
      help.push(`Run \`az-axi ${path}${suffix} --full\` to show every fetched row`);
    }
    help.push(...pagingHelp);
    return {
      profile: profile.name,
      total,
      count: fetched.nextLink ? `${shown.length} of ${total} metric definitions` : countLine(shown.length, definitions.length, "metric definitions"),
      rows: picked,
      help,
    };
  }

  const values = redact(await request<{ value?: MetricValue[] }>(profile, {
    method: "GET",
    path: `${resource}/providers/Microsoft.Insights/metrics`,
    apiVersion: MONITOR_METRICS,
    query: {
      timespan: `${from}/${to}`,
      metricnames: metricNames.join(","),
      ...(interval ? { interval } : {}),
      ...(aggregations?.length ? { aggregation: aggregations.join(",") } : {}),
    },
  })).value ?? [];
  const failures = values.filter((entry) => entry.errorCode && entry.errorCode !== "Success");
  if (failures.length) {
    throw new AxiError(failures.map((entry) =>
      `${metricNameOf(entry)}: ${entry.errorCode}${entry.errorMessage ? `: ${entry.errorMessage}` : ""}`).join("; "),
      "API_ERROR", [monitorLeafHelp(path)]);
  }
  const valueSuffix = `${suffix} ${formatFlagValue("metric", metricNames.join(","))} ${querySuffix}`;
  if (values.length === 0) {
    return {
      profile: profile.name,
      total: 0,
      count: countLine(0, 0, "metrics"),
      rows: emptyState("metrics", `${scopeLabel(subs.length, resource)} from ${from} to ${to}`),
      help: [`Run \`az-axi ${path}${valueSuffix} --full\` to show every fetched row`],
    };
  }
  const rows: AnyObj[] = [];
  for (const entry of values) {
    const name = metricNameOf(entry);
    const points = (entry.timeseries ?? []).flatMap((series) => series.data ?? []);
    const stamped = points.filter((datum) => typeof datum.timeStamp === "string" && Object.keys(datumValues(datum)).length > 0);
    const latest = stamped[stamped.length - 1];
    const body: AnyObj = {
      metric: name,
      unit: str(entry.unit),
      points: points.length,
      latest: latest ? datumValues(latest) : "",
      time: latest ? str(latest.timeStamp) : "",
      from,
      to,
    };
    if (full) {
      const shown = stamped.slice(0, limit);
      body.series = shown.map((datum) => ({ time: str(datum.timeStamp), ...datumValues(datum) }));
      if (stamped.length > shown.length) {
        body.seriesNote = `showing ${shown.length} of ${stamped.length} points; narrow the window or interval`;
      }
    }
    rows.push(body);
  }
  return {
    profile: profile.name,
    total: values.length,
    count: countLine(rows.length, values.length, "metrics"),
    rows: pickFields(rows, fields),
    ...(full ? {} : { help: [`Run \`az-axi ${path}${valueSuffix} --full\` for the per-metric series (points capped at --limit; narrow the window or interval)`] }),
  };
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  if (args.positionals[0] === "log-analytics" && args.positionals[1] === "workspace") {
    return runDiscovery("workspace", argv.slice(2));
  }
  const words = args.positionals.slice(0, -1);
  const verb = args.positionals[args.positionals.length - 1];
  const path = `monitor ${words.join(" ")} ${verb}`;
  const key = words.join(" ");
  if (key === "metrics alert" || key === "action-group") {
    const collection = READ_COLLECTIONS.find((candidate) =>
      candidate.words.length === words.length && candidate.words.every((word, index) => words[index] === word))!;
    if (verb !== "list" && verb !== "show") {
      invalid(`expected ${path} list|show`, path);
    }
    if (args.positionals.length !== words.length + 1) {
      invalid(`unexpected argument \`${args.positionals[words.length + 1]}\` for \`${path}\``, path);
    }
    assertKnownFlags(args, commandFlags(path), path, monitorLeafHelp(path));
    const profile = profileFromArgs(args);
    if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
      invalid("management-group scope is unsupported for Monitor reads; select subscriptions explicitly", path);
    }
    if (verb === "list") return runGovernanceList(profile, args, collection, path);
    const ids = flagText(args, "ids");
    if (ids) resourceScope(ids, "ids", path);
    return runGovernanceShow(profile, args, collection, path, (subscription, group, name) =>
      showPath(collection, subscription, group, name, path));
  }
  if (key === "diagnostic-settings") {
    if (verb !== "list" && verb !== "show") invalid(`expected ${path} list|show`, path);
    if (args.positionals.length !== words.length + 1) {
      invalid(`unexpected argument \`${args.positionals[words.length + 1]}\` for \`${path}\``, path);
    }
    assertKnownFlags(args, commandFlags(path), path, monitorLeafHelp(path));
    const profile = profileFromArgs(args);
    if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
      invalid("management-group scope is unsupported for Monitor reads; select subscriptions explicitly", path);
    }
    if (verb === "list") return runDiagnosticSettingsList(profile, args, path);
    return runDiagnosticSettingsShow(profile, args, path);
  }
  if (key === "metrics" && verb === "list") {
    if (args.positionals.length !== 2) {
      invalid(`unexpected argument \`${args.positionals[2]}\` for \`${path}\``, path);
    }
    assertKnownFlags(args, commandFlags(path), path, monitorLeafHelp(path));
    const profile = profileFromArgs(args);
    return runMetricsList(profile, args, path);
  }
  invalid("expected monitor metrics alert|action-group|diagnostic-settings list|show, or monitor metrics list", path);
}
