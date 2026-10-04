import { AxiError } from "axi-sdk-js";
import { LOG_ANALYTICS_WORKSPACES, SENTINEL_INCIDENTS } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagText, parseArgs } from "../lib/args.js";
import { request, requestAll } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import type { ResolvedProfile } from "../lib/config.js";
import { subscriptions } from "../lib/discovery.js";
import { countLine, emptyState, pickFields, shortDate, truncate } from "../lib/format.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { parseSubscriptionId } from "../lib/scope.js";
import { formatFlagValue } from "../lib/shell.js";
import { parseSince } from "../lib/time.js";

export const meta = commandMeta("sentinel");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^\d+$/;
const INCIDENT_ID =
  /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.OperationalInsights\/workspaces\/([^/]+)\/providers\/Microsoft\.SecurityInsights\/incidents\/([^/]+)$/i;
const WORKSPACE_ID =
  /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.OperationalInsights\/workspaces\/([^/]+)$/i;
const CELL_TRUNCATE = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

/** `--fields` accepts the compact row keys plus id, created and owner. */
const FIELD_ALLOWLIST = ["number", "id", "title", "severity", "status", "time", "created", "owner"];

interface IncidentOwner {
  assignedTo?: string;
  email?: string;
  userPrincipalName?: string;
  objectId?: string;
}

interface IncidentProperties {
  incidentNumber?: number;
  title?: string;
  description?: string;
  severity?: string;
  status?: string;
  createdTimeUtc?: string;
  lastModifiedTimeUtc?: string;
  owner?: IncidentOwner;
  labels?: Array<{ labelName?: string }>;
  providerName?: string;
  additionalData?: { alertsCount?: number; tactics?: string[] };
}

interface Incident {
  id?: string;
  name?: string;
  properties?: IncidentProperties;
}

interface WorkspaceItem extends Record<string, unknown> {
  id: string;
  name: string;
  properties?: { customerId?: string };
}

function invalid(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `az-axi sentinel incident list --help` or `az-axi sentinel incident show --help` for selectors"]);
}

function segment(value: string, flag: string): string {
  if (/[/%?#\\]/.test(value) || value === "." || value === ".." || !value.trim()) {
    invalid(`--${flag} must name one resource path segment`);
  }
  return encodeURIComponent(value.trim());
}

function eventTime(value: string | undefined): number {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
}

function ownerText(owner: IncidentOwner | undefined): string {
  if (!owner) return "";
  return owner.assignedTo || owner.email || owner.userPrincipalName || "";
}

function incidentTime(properties: IncidentProperties): string {
  return shortDate(properties.createdTimeUtc);
}

function compactRow(incident: Incident): Record<string, unknown> {
  const properties = incident.properties ?? {};
  return {
    number: properties.incidentNumber ?? "",
    severity: properties.severity ?? "",
    title: properties.title ?? "",
    status: properties.status ?? "",
    time: incidentTime(properties),
  };
}

function fullRow(incident: Incident): Record<string, unknown> {
  const properties = incident.properties ?? {};
  return {
    ...compactRow(incident),
    id: incident.id ?? "",
    created: properties.createdTimeUtc ?? "",
    owner: ownerText(properties.owner),
  };
}

function incidentBase(subscription: string, resourceGroup: string, workspaceName: string): string {
  return `/subscriptions/${subscription}/resourceGroups/${segment(resourceGroup, "resource-group")}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${segment(workspaceName, "workspace-name")}` +
    "/providers/Microsoft.SecurityInsights/incidents";
}

/** Alias wins; otherwise the value must be a workspace ID GUID (customer ID). */
function workspaceGuid(profile: ResolvedProfile, raw: string): string {
  const text = raw.trim();
  const entries = profile.workspaces;
  if (entries && typeof entries === "object" && !Array.isArray(entries) &&
    Object.hasOwnProperty.call(entries, text)) {
    const mapped = (entries as Record<string, unknown>)[text];
    const id = typeof mapped === "string" ? mapped.trim().replace(/^\{(.+)\}$/, "$1") : undefined;
    if (!id || !GUID.test(id)) invalid(`workspace alias '${text}' is not a workspace ID GUID`);
    return id!;
  }
  const direct = text.replace(/^\{(.+)\}$/, "$1");
  if (GUID.test(direct)) return direct;
  const aliases = entries && typeof entries === "object" && !Array.isArray(entries) ? Object.keys(entries) : [];
  throw new AxiError(`unknown workspace '${text}'`, "VALIDATION_ERROR", [
    ...(aliases.length > 0 ? [`Known aliases: ${aliases.join(", ")}`] : []),
    "Pass --workspace <alias> or --workspace <workspace-id-guid> (the customer ID, not the ARM resource ID)",
  ]);
}

interface WorkspaceTarget {
  subscription: string;
  resourceGroup: string;
  workspaceName: string;
  label: string;
}

/** Pure workspace-selector validation: no transport, so unknown or
 * conflicting selectors fail before any dependency call. */
function selectorError(args: ReturnType<typeof parseArgs>, verb: "list" | "show"): string | undefined {
  const ids = flagText(args, "ids");
  const workspaceName = flagText(args, "workspace-name");
  const group = flagText(args, "resource-group");
  const workspace = flagText(args, "workspace");
  if (ids) {
    if (verb === "list") return "incident list takes no --ids; use `sentinel incident show --ids <incident-ARM-id>`";
    if (workspaceName || group || workspace) return "--ids selects the incident itself; workspace selectors are not accepted with --ids";
    return undefined;
  }
  if (workspace && (workspaceName || group)) return "--workspace conflicts with --workspace-name and --resource-group";
  if (!workspace && !(workspaceName && group)) {
    return verb === "show"
      ? "incident show needs --workspace-name and --resource-group, --workspace <alias|guid>, or --ids <incident-ARM-id>"
      : "incident list needs --workspace-name and --resource-group, or --workspace <alias|guid>";
  }
  // Path-segment shape is pure: reject it before any subscription transport.
  if (workspaceName) segment(workspaceName, "workspace-name");
  if (group) segment(group, "resource-group");
  return undefined;
}

/** A list filter. Absent is `undefined`; present without a value is refused
 * so an agent cannot silently drop a filter. */
function filterList(args: ReturnType<typeof parseArgs>, name: string): string[] | undefined {
  if (!(name in args.flags)) return undefined;
  const list = flagList(args, name);
  if (list === undefined) invalid(`flag --${name} needs a non-empty value`);
  return list!.map((s) => s.toLowerCase());
}

/**
 * Resolves the Sentinel workspace from az-shaped selectors or a profile
 * workspace alias/GUID. Alias/GUID resolution lists ARM workspaces in the one
 * selected subscription and matches the customer ID, reusing the slice 3b
 * workspace list contract (allowlisted metadata only).
 */
async function resolveWorkspace(
  profile: ResolvedProfile,
  args: ReturnType<typeof parseArgs>,
  subscription: string,
): Promise<WorkspaceTarget> {
  const workspaceName = flagText(args, "workspace-name");
  const group = flagText(args, "resource-group");
  const workspace = flagText(args, "workspace");
  if (!workspace) {
    return {
      subscription,
      resourceGroup: group!.trim(),
      workspaceName: workspaceName!.trim(),
      label: `in workspace ${workspaceName!.trim()}`,
    };
  }
  const guid = workspaceGuid(profile, workspace);
  const page = await requestAll<WorkspaceItem>(profile,
    { method: "GET", path: `/subscriptions/${subscription}/providers/Microsoft.OperationalInsights/workspaces`, apiVersion: LOG_ANALYTICS_WORKSPACES }, 100);
  const matches = page.items.filter((item) => item.properties?.customerId?.toLowerCase() === guid.toLowerCase());
  if (page.nextLink && matches.length < 2) {
    throw new AxiError(
      `workspace search is incomplete; paging stopped at 100 pages in subscription ${subscription}`,
      "INCOMPLETE_SEARCH",
      ["Use --workspace-name and --resource-group to select the workspace directly"],
    );
  }
  if (matches.length !== 1) {
    throw new AxiError(
      matches.length === 0
        ? `workspace '${workspace.trim()}' matched no workspace in subscription ${subscription}`
        : `workspace '${workspace.trim()}' matched ${matches.length} workspaces; use --workspace-name and --resource-group`,
      "VALIDATION_ERROR",
      [`Run \`az-axi monitor log-analytics workspace list --subscription ${subscription}\` to find the workspace`],
    );
  }
  const idMatch = WORKSPACE_ID.exec(matches[0]!.id);
  if (!idMatch) invalid("workspace list returned an unexpected resource ID");
  return {
    subscription,
    resourceGroup: idMatch[2]!,
    workspaceName: idMatch[3]!,
    label: `in workspace ${matches[0]!.name}`,
  };
}

function selectorSuffix(args: ReturnType<typeof parseArgs>, subscription: string, target: WorkspaceTarget | undefined): string {
  const identity = ["profile", "config", "tenant"]
    .filter((key) => typeof args.flags[key] === "string")
    .map((key) => ` ${formatFlagValue(key, args.flags[key] as string)}`).join("");
  const scope = ` ${formatFlagValue("subscription", subscription)}`;
  if (!target) return `${identity}${scope}`;
  return `${identity} ${formatFlagValue("resource-group", target.resourceGroup)} ` +
    `${formatFlagValue("workspace-name", target.workspaceName)}${scope}`;
}

async function runList(profile: ResolvedProfile, args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !FIELD_ALLOWLIST.includes(field))) {
    invalid(`incident list --fields supports only: ${FIELD_ALLOWLIST.join(", ")}`);
  }
  if (args.flags["limit"] === true || args.flags["limit"] === "") {
    throw new AxiError("flag --limit needs a number", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }
  const limit = flagNumber(args, "limit") ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) invalid("--limit must be a positive integer");
  if (limit > MAX_LIMIT) invalid(`--limit must be at most ${MAX_LIMIT}`);
  const statuses = filterList(args, "status");
  const severities = filterList(args, "severity");
  const owner = flagText(args, "owner")?.toLowerCase();
  const sinceRaw = flagText(args, "since");
  const sinceMs = sinceRaw ? parseSince(sinceRaw).getTime() : undefined;
  const selectors = selectorError(args, "list");
  if (selectors) invalid(selectors);
  // Alias existence is profile-local: reject unknown workspaces before transport.
  const workspaceFlag = flagText(args, "workspace");
  if (workspaceFlag) workspaceGuid(profile, workspaceFlag);

  const ids = await subscriptions(profile);
  if (ids.length !== 1) invalid("incident list needs exactly one subscription; use --subscription <id>");
  const target = await resolveWorkspace(profile, args, ids[0]!);
  const suffix = selectorSuffix(args, ids[0]!, target);

  const page = await requestAll<Incident>(profile,
    { method: "GET", path: incidentBase(target.subscription, target.resourceGroup, target.workspaceName), apiVersion: SENTINEL_INCIDENTS });
  let collected = page.items.filter((incident) => {
    const properties = incident.properties ?? {};
    if (statuses?.length && !statuses.includes((properties.status ?? "").toLowerCase())) return false;
    if (severities?.length && !severities.includes((properties.severity ?? "").toLowerCase())) return false;
    if (owner && ![properties.owner?.assignedTo, properties.owner?.email, properties.owner?.userPrincipalName]
      .some((identity) => identity?.toLowerCase().includes(owner))) return false;
    if (sinceMs !== undefined && eventTime(properties.createdTimeUtc) < sinceMs) return false;
    return true;
  });
  collected.sort((a, b) => eventTime(b.properties?.createdTimeUtc) - eventTime(a.properties?.createdTimeUtc));

  const scopeHint = `${target.label}${sinceRaw ? ` since ${sinceRaw}` : ""}`;
  if (collected.length === 0) {
    return {
      profile: profile.name,
      workspace: target.workspaceName,
      total: page.nextLink ? "0+" : 0,
      count: countLine(0, 0, "incidents"),
      rows: emptyState("incidents", page.nextLink ? `${scopeHint} in fetched pages; search is incomplete` : scopeHint),
      help: [
        `Widen the window: \`az-axi sentinel incident list${suffix} --since 30d\``,
        `Drop a filter: \`az-axi sentinel incident list${suffix}\``,
        ...(page.nextLink ? ["More pages exist; paging stopped at 10 pages. Counts are lower bounds. Narrow with --status, --severity, --owner or --since."] : []),
      ],
    };
  }

  const bySeverity: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const incident of collected) {
    const severity = incident.properties?.severity || "(unknown)";
    const status = incident.properties?.status || "(unknown)";
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  const base = full || fields ? fullRow : compactRow;
  const shown = (full ? collected : collected.slice(0, limit)).map(base);
  const picked = pickFields(shown, fields);

  const first = collected[0]!;
  const firstSelector = first.name && GUID.test(first.name) ? `--name ${first.name}` : `--name ${first.properties?.incidentNumber ?? first.name}`;
  const help: string[] = [
    `Run \`az-axi sentinel incident show ${firstSelector}${suffix}\` for the newest incident in detail`,
  ];
  if (shown.length < collected.length) {
    help.push(`Run \`az-axi sentinel incident list${suffix} --full\` to show every fetched row`);
  }
  if (page.nextLink) {
    help.push("More pages exist; paging stopped at 10 pages. Counts are lower bounds. Narrow with --status, --severity, --owner or --since.");
  }
  return {
    profile: profile.name,
    workspace: target.workspaceName,
    total: page.nextLink ? `${collected.length}+` : collected.length,
    count: countLine(shown.length, collected.length, "incidents"),
    bySeverity,
    byStatus,
    rows: picked,
    help,
  };
}

async function listForNumber(
  profile: ResolvedProfile,
  target: WorkspaceTarget,
  incidentNumber: number,
  listHint: string,
): Promise<Incident> {
  const page = await requestAll<Incident>(profile,
    { method: "GET", path: incidentBase(target.subscription, target.resourceGroup, target.workspaceName), apiVersion: SENTINEL_INCIDENTS });
  const match = page.items
    .filter((incident) => incident.properties?.incidentNumber === incidentNumber)
    .sort((a, b) => eventTime(b.properties?.createdTimeUtc) - eventTime(a.properties?.createdTimeUtc))[0];
  if (!match) {
    if (page.nextLink) {
      throw new AxiError(`incident number ${incidentNumber} was not found in fetched pages; search is incomplete after 10 pages`, "INCOMPLETE_SEARCH", [
        "Use --name <incident-guid> or --ids <incident-ARM-id> to select the incident directly",
        `Run \`${listHint}\` to list fetched incident numbers`,
      ]);
    }
    throw new AxiError(`not found: incident number ${incidentNumber} ${target.label}`, "NOT_FOUND", [
      `Run \`${listHint}\` to list incident numbers`,
    ]);
  }
  return match;
}

async function runShow(profile: ResolvedProfile, args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const nameFlag = flagText(args, "name");
  const incidentIdFlag = flagText(args, "incident-id");
  if (nameFlag && incidentIdFlag && nameFlag.trim() !== incidentIdFlag.trim()) {
    invalid("--name conflicts with --incident-id");
  }
  const name = nameFlag ?? incidentIdFlag;
  const ids = flagText(args, "ids");
  if (name && ids) invalid("incident show takes --name or --ids, not both");
  if (!name && !ids) invalid("incident show needs --name <incident-id|number> or --ids <incident-ARM-id>");
  const selectors = selectorError(args, "show");
  if (selectors) invalid(selectors);
  if (name && !NUMBER.test(name.trim()) && !GUID.test(name.trim())) {
    invalid("--name must be the incident GUID or its incident number; full ARM IDs need --ids");
  }
  const workspaceFlag = flagText(args, "workspace");
  if (workspaceFlag) workspaceGuid(profile, workspaceFlag);

  let incident: Incident;
  let target: WorkspaceTarget | undefined;
  let subscription: string;
  if (ids) {
    const match = INCIDENT_ID.exec(ids.trim());
    if (!match) invalid("--ids must be one incident ARM ID under Microsoft.SecurityInsights/incidents");
    subscription = match[1]!;
    if (!GUID.test(subscription)) invalid("--ids must carry a subscription GUID");
    if (!GUID.test(match[4]!)) invalid("--ids must end in the incident GUID");
    const selected = profile.subscriptions?.length ? await subscriptions(profile) : [subscription];
    if (!selected.some((id) => id.toLowerCase() === subscription.toLowerCase())) {
      invalid("--ids conflicts with selected subscriptions");
    }
    incident = await request<Incident>(profile, {
      method: "GET",
      path: `/subscriptions/${subscription}/resourceGroups/${segment(match[2]!, "ids")}` +
        `/providers/Microsoft.OperationalInsights/workspaces/${segment(match[3]!, "ids")}` +
        `/providers/Microsoft.SecurityInsights/incidents/${match[4]!}`,
      apiVersion: SENTINEL_INCIDENTS,
    });
  } else {
    const selected = await subscriptions(profile);
    if (selected.length !== 1) invalid("incident show by name needs exactly one subscription; use --subscription <id>");
    subscription = selected[0]!;
    target = await resolveWorkspace(profile, args, subscription);
    const base = incidentBase(target.subscription, target.resourceGroup, target.workspaceName);
    if (NUMBER.test(name!.trim())) {
      incident = await listForNumber(profile, target, Number(name!.trim()),
        `az-axi sentinel incident list${selectorSuffix(args, subscription, target)}`);
    } else {
      incident = await request<Incident>(profile, {
        method: "GET",
        path: `${base}/${name!.trim()}`,
        apiVersion: SENTINEL_INCIDENTS,
      });
    }
  }
  const suffix = selectorSuffix(args, subscription, target);

  const properties = incident.properties ?? {};
  const description = properties.description ?? "";
  const descriptionText = full ? { text: description, truncated: false } : truncate(description, CELL_TRUNCATE);
  const labels = (properties.labels ?? []).map((label) => label.labelName).filter(Boolean);
  const tactics = properties.additionalData?.tactics ?? [];
  const help: string[] = [];
  if (!full && descriptionText.truncated) {
    const selector = ids ? `--ids ${incident.id ?? ids.trim()}` : `--name ${incident.name ?? name!.trim()}`;
    help.push(`Run \`az-axi sentinel incident show ${selector}${suffix} --full\` for the complete description`);
  }

  const workspaceFromId = (incident.id ?? "").split("/workspaces/")[1]?.split("/")[0] ?? "";
  return {
    profile: profile.name,
    workspace: target?.workspaceName ?? workspaceFromId,
    number: properties.incidentNumber ?? "",
    id: incident.id ?? "",
    title: properties.title ?? "",
    description: descriptionText.text,
    severity: properties.severity ?? "",
    status: properties.status ?? "",
    created: properties.createdTimeUtc ?? "",
    modified: properties.lastModifiedTimeUtc ?? "",
    owner: ownerText(properties.owner),
    labels,
    provider: properties.providerName ?? "",
    tactics,
    alerts: properties.additionalData?.alertsCount ?? "",
    subscription: parseSubscriptionId(incident.id ?? "") ?? subscription,
    ...(help.length > 0 ? { help } : {}),
  };
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  if (args.positionals[0] !== "incident") {
    throw new AxiError(
      args.positionals[0] ? `unknown command \`sentinel ${args.positionals[0]}\`` : "missing subcommand for `sentinel`",
      "VALIDATION_ERROR",
      ["Run `az-axi sentinel incident list|show --help` for usage"],
    );
  }
  const verb = args.positionals[1];
  if (verb !== "list" && verb !== "show") {
    throw new AxiError(
      verb ? `unknown command \`sentinel incident ${verb}\`` : "missing verb for `sentinel incident`",
      "VALIDATION_ERROR",
      ["Expected one of: list | show", "Run `az-axi sentinel incident list --help` for usage"],
    );
  }
  if (args.positionals.length > 2) {
    throw new AxiError(`unexpected argument \`${args.positionals[2]}\` for \`sentinel incident ${verb}\``, "VALIDATION_ERROR", [
      `Run \`az-axi sentinel incident ${verb} --help\` for usage`,
    ]);
  }
  assertKnownFlags(args, commandFlags(`sentinel incident ${verb}`), `sentinel incident ${verb}`);
  const profile = profileFromArgs(args);
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
    invalid("management-group scope is unsupported for Sentinel incidents; select one subscription explicitly");
  }
  if (verb === "list") return runList(profile, args);
  return runShow(profile, args);
}
