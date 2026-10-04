import { AxiError } from "axi-sdk-js";
import { randomUUID } from "node:crypto";
import { LOG_ANALYTICS_WORKSPACES, SENTINEL_ALERT_RULES, SENTINEL_DATA_CONNECTORS, SENTINEL_INCIDENTS } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagText, parseArgs } from "../lib/args.js";
import { buildUrl, request, requestAll } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import type { ResolvedProfile } from "../lib/config.js";
import { subscriptions } from "../lib/discovery.js";
import { dryRun } from "../lib/dryRun.js";
import { executeWrite } from "../lib/execute.js";
import { enforceGates } from "../lib/gates.js";
import { countLine, emptyState, pickFields, shortDate, truncate } from "../lib/format.js";
import { parseTimeoutFlag } from "../lib/lro.js";
import { assertReadOnlyBoundary, classifyRequest } from "../lib/policy.js";
import { commandFlags, commandMeta, runWithEffect } from "../lib/registry.js";
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

/** `--fields` accepts the compact alert keys plus the full-row additions. */
const ALERT_FIELD_ALLOWLIST = ["name", "alert", "severity", "status", "time", "id", "tactics", "product"];

/** `--fields` accepts the compact entity keys plus the full-row ARM ID. */
const ENTITY_FIELD_ALLOWLIST = ["kind", "entity", "name", "id"];

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
  classification?: string;
  classificationReason?: string;
  classificationComment?: string;
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

interface AlertProperties {
  alertDisplayName?: string;
  severity?: string;
  status?: string;
  tactics?: string[];
  productName?: string;
  vendorName?: string;
  timeGenerated?: string;
  startTimeUtc?: string;
}

interface AlertItem {
  id?: string;
  name?: string;
  kind?: string;
  properties?: AlertProperties;
}

interface EntityItem {
  id?: string;
  name?: string;
  kind?: string;
  properties?: Record<string, unknown>;
}

interface EntitiesResponse {
  entities?: EntityItem[];
  metaData?: Array<{ entityKind?: string; count?: number }>;
}

function invalid(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `az-axi sentinel --help` for selectors"]);
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
 * conflicting selectors fail before any dependency call. `label` names the
 * verb in errors; reads pass their own verb, writes pass theirs. */
function selectorError(args: ReturnType<typeof parseArgs>, verb: string, label: string = verb): string | undefined {
  const ids = flagText(args, "ids");
  const workspaceName = flagText(args, "workspace-name");
  const group = flagText(args, "resource-group");
  const workspace = flagText(args, "workspace");
  if (ids) {
    if (verb === "list") return `incident list takes no --ids; use \`sentinel incident show --ids <incident-ARM-id>\``;
    if (workspaceName || group || workspace) return "--ids selects the incident itself; workspace selectors are not accepted with --ids";
    return undefined;
  }
  if (workspace && (workspaceName || group)) return "--workspace conflicts with --workspace-name and --resource-group";
  if (!workspace && !(workspaceName && group)) {
    return verb !== "list"
      ? `incident ${label} needs --name <incident-id|number> with --workspace-name and --resource-group, --workspace <alias|guid>, or --ids <incident-ARM-id>`
      : `incident ${label} needs --workspace-name and --resource-group, or --workspace <alias|guid>`;
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
  const filterSuffix = ["status", "severity", "owner"]
    .filter((key) => typeof args.flags[key] === "string")
    .map((key) => ` ${formatFlagValue(key, args.flags[key] as string)}`).join("");

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
        `Widen the window: \`az-axi sentinel incident list${suffix}${filterSuffix} --since 30d\``,
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
    help.push(`Run \`az-axi sentinel incident list${suffix}${filterSuffix}${sinceRaw ? ` ${formatFlagValue("since", sinceRaw)}` : ""} --full\` to show every fetched row`);
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

interface IncidentIdentity {
  subscription: string;
  target: WorkspaceTarget;
  /** The incident GUID name used in related-action paths. */
  incidentId: string;
  /** The label used in empty states and hints: the number when selected by number, else the GUID. */
  label: string;
}

/**
 * Resolves the incident selectors shared by show and the related reads to one
 * incident GUID: exactly one `--ids` ARM ID, or `--name`/`--incident-id` as a
 * GUID or sequential number with workspace selectors. Numbers resolve through
 * the same bounded list as show; the outgoing related-action path always
 * carries the GUID, which is what the reviewed read classification requires.
 */
async function resolveIncidentIdentity(
  profile: ResolvedProfile,
  args: ReturnType<typeof parseArgs>,
  verb: string,
): Promise<IncidentIdentity> {
  const nameFlag = flagText(args, "name");
  const incidentIdFlag = flagText(args, "incident-id");
  if (nameFlag && incidentIdFlag && nameFlag.trim() !== incidentIdFlag.trim()) {
    invalid("--name conflicts with --incident-id");
  }
  const name = nameFlag ?? incidentIdFlag;
  const ids = flagText(args, "ids");
  if (name && ids) invalid(`incident ${verb} takes --name or --ids, not both`);
  if (!name && !ids) invalid(`incident ${verb} needs --name <incident-id|number> or --ids <incident-ARM-id>`);
  const selectors = selectorError(args, verb);
  if (selectors) invalid(selectors);
  if (name && !NUMBER.test(name.trim()) && !GUID.test(name.trim())) {
    invalid("--name must be the incident GUID or its incident number; full ARM IDs need --ids");
  }
  const workspaceFlag = flagText(args, "workspace");
  if (workspaceFlag) workspaceGuid(profile, workspaceFlag);

  if (ids) {
    const match = INCIDENT_ID.exec(ids.trim());
    if (!match) invalid("--ids must be one incident ARM ID under Microsoft.SecurityInsights/incidents");
    const subscription = match[1]!;
    if (!GUID.test(subscription)) invalid("--ids must carry a subscription GUID");
    if (!GUID.test(match[4]!)) invalid("--ids must end in the incident GUID");
    const selected = profile.subscriptions?.length ? await subscriptions(profile) : [subscription];
    if (!selected.some((id) => id.toLowerCase() === subscription.toLowerCase())) {
      invalid("--ids conflicts with selected subscriptions");
    }
    const workspaceName = match[3]!;
    return {
      subscription,
      target: { subscription, resourceGroup: match[2]!, workspaceName, label: `in workspace ${workspaceName}` },
      incidentId: match[4]!,
      label: match[4]!,
    };
  }
  const selected = await subscriptions(profile);
  if (selected.length !== 1) invalid(`incident ${verb} by name needs exactly one subscription; use --subscription <id>`);
  const subscription = selected[0]!;
  const target = await resolveWorkspace(profile, args, subscription);
  if (NUMBER.test(name!.trim())) {
    const incident = await listForNumber(profile, target, Number(name!.trim()),
      `az-axi sentinel incident list${selectorSuffix(args, subscription, target)}`);
    if (!incident.name || !GUID.test(incident.name)) invalid("incident lookup returned an unexpected incident name");
    return { subscription, target, incidentId: incident.name, label: name!.trim() };
  }
  return { subscription, target, incidentId: name!.trim(), label: name!.trim() };
}

function alertTime(properties: AlertProperties): string {
  return shortDate(properties.timeGenerated ?? properties.startTimeUtc);
}

function compactAlertRow(alert: AlertItem): Record<string, unknown> {
  const properties = alert.properties ?? {};
  return {
    name: alert.name ?? "",
    alert: properties.alertDisplayName ?? "",
    severity: properties.severity ?? "",
    status: properties.status ?? "",
    time: alertTime(properties),
  };
}

function fullAlertRow(alert: AlertItem): Record<string, unknown> {
  const properties = alert.properties ?? {};
  return {
    ...compactAlertRow(alert),
    id: alert.id ?? "",
    tactics: properties.tactics ?? [],
    product: properties.productName ?? "",
  };
}

function entityDisplayName(entity: EntityItem): string {
  const properties = entity.properties ?? {};
  for (const key of ["friendlyName", "accountName", "hostName", "address", "fileName", "url"]) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function compactEntityRow(entity: EntityItem): Record<string, unknown> {
  return {
    kind: entity.kind ?? "",
    entity: entityDisplayName(entity),
    name: entity.name ?? "",
  };
}

function fullEntityRow(entity: EntityItem): Record<string, unknown> {
  return { ...compactEntityRow(entity), id: entity.id ?? "" };
}

function limitValue(args: ReturnType<typeof parseArgs>): number {
  if (args.flags["limit"] === true || args.flags["limit"] === "") {
    throw new AxiError("flag --limit needs a number", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }
  const limit = flagNumber(args, "limit") ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) invalid("--limit must be a positive integer");
  if (limit > MAX_LIMIT) invalid(`--limit must be at most ${MAX_LIMIT}`);
  return limit;
}

function relatedBase(identity: IncidentIdentity, target: WorkspaceTarget): string {
  return `${incidentBase(target.subscription, target.resourceGroup, target.workspaceName)}/${identity.incidentId}`;
}

async function runAlertList(profile: ResolvedProfile, args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !ALERT_FIELD_ALLOWLIST.includes(field))) {
    invalid(`incident list-alert --fields supports only: ${ALERT_FIELD_ALLOWLIST.join(", ")}`);
  }
  const limit = limitValue(args);
  const identity = await resolveIncidentIdentity(profile, args, "list-alert");
  const target = identity.target;
  const suffix = selectorSuffix(args, identity.subscription, target);
  const incidentSelector = `--name ${identity.incidentId}`;
  // Reviewed bodyless read POST: Incidents_ListAlerts returns `{ value: [...] }` with no paging.
  const body = await request<{ value?: AlertItem[] }>(profile, {
    method: "POST",
    path: `${relatedBase(identity, target)}/alerts`,
    apiVersion: SENTINEL_INCIDENTS,
  });
  const collected = body?.value ?? [];
  const scopeHint = `for incident ${identity.label} in workspace ${target.workspaceName}`;
  if (collected.length === 0) {
    return {
      profile: profile.name,
      workspace: target.workspaceName,
      incident: identity.label,
      total: 0,
      count: countLine(0, 0, "incident alerts"),
      rows: emptyState("incident alerts", scopeHint),
      help: [`Run \`az-axi sentinel incident show ${incidentSelector}${suffix}\` for the incident in detail`],
    };
  }

  const bySeverity: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const alert of collected) {
    const severity = alert.properties?.severity || "(unknown)";
    const status = alert.properties?.status || "(unknown)";
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  const shown = (full ? collected : collected.slice(0, limit)).map(full || fields ? fullAlertRow : compactAlertRow);
  const picked = pickFields(shown, fields);
  const help: string[] = [
    `Run \`az-axi sentinel incident list-entity ${incidentSelector}${suffix}\` for the related entities`,
  ];
  if (shown.length < collected.length) {
    help.push(`Run \`az-axi sentinel incident list-alert ${incidentSelector}${suffix} --full\` to show every related alert`);
  }
  return {
    profile: profile.name,
    workspace: target.workspaceName,
    incident: identity.label,
    total: collected.length,
    count: countLine(shown.length, collected.length, "incident alerts"),
    bySeverity,
    byStatus,
    rows: picked,
    help,
  };
}

async function runEntityList(profile: ResolvedProfile, args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !ENTITY_FIELD_ALLOWLIST.includes(field))) {
    invalid(`incident list-entity --fields supports only: ${ENTITY_FIELD_ALLOWLIST.join(", ")}`);
  }
  const limit = limitValue(args);
  const identity = await resolveIncidentIdentity(profile, args, "list-entity");
  const target = identity.target;
  const suffix = selectorSuffix(args, identity.subscription, target);
  const incidentSelector = `--name ${identity.incidentId}`;
  // Reviewed bodyless read POST: Incidents_ListEntities returns `{ entities, metaData }` with no paging.
  const body = await request<EntitiesResponse>(profile, {
    method: "POST",
    path: `${relatedBase(identity, target)}/entities`,
    apiVersion: SENTINEL_INCIDENTS,
  });
  const collected = body?.entities ?? [];
  const scopeHint = `for incident ${identity.label} in workspace ${target.workspaceName}`;
  if (collected.length === 0) {
    return {
      profile: profile.name,
      workspace: target.workspaceName,
      incident: identity.label,
      total: 0,
      count: countLine(0, 0, "incident entities"),
      rows: emptyState("incident entities", scopeHint),
      help: [`Run \`az-axi sentinel incident show ${incidentSelector}${suffix}\` for the incident in detail`],
    };
  }

  const byKind: Record<string, number> = {};
  for (const entry of body?.metaData ?? []) {
    if (entry.entityKind) byKind[entry.entityKind] = entry.count ?? 0;
  }
  if (Object.keys(byKind).length === 0) {
    for (const entity of collected) {
      const kind = entity.kind || "(unknown)";
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
  }

  const shown = (full ? collected : collected.slice(0, limit)).map(full || fields ? fullEntityRow : compactEntityRow);
  const picked = pickFields(shown, fields);
  const help: string[] = [
    `Run \`az-axi sentinel incident list-alert ${incidentSelector}${suffix}\` for the related alerts`,
  ];
  if (shown.length < collected.length) {
    help.push(`Run \`az-axi sentinel incident list-entity ${incidentSelector}${suffix} --full\` to show every related entity`);
  }
  return {
    profile: profile.name,
    workspace: target.workspaceName,
    incident: identity.label,
    total: collected.length,
    count: countLine(shown.length, collected.length, "incident entities"),
    byKind,
    rows: picked,
    help,
  };
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

/**
 * Slice 4c: read-only analytics rules and data connectors. All four verbs are
 * plain ARM GETs (AlertRules_List/Get, DataConnectors_List/Get), so they
 * classify as reads with no policy change. Rule and connector mutation stays
 * out of scope: no PUT/POST/PATCH/DELETE path exists here. Connector rows
 * project an explicit safelist of metadata fields, so secrets, keys and
 * credential fields are omitted by construction on top of global redaction.
 */
const ALERT_RULE_ID =
  /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.OperationalInsights\/workspaces\/([^/]+)\/providers\/Microsoft\.SecurityInsights\/alertRules\/([^/]+)$/i;
const DATA_CONNECTOR_ID =
  /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.OperationalInsights\/workspaces\/([^/]+)\/providers\/Microsoft\.SecurityInsights\/dataConnectors\/([^/]+)$/i;

/** `--fields` accepts the compact rule keys plus id, tactics, template and modified. */
const RULE_FIELD_ALLOWLIST = ["name", "rule", "kind", "enabled", "severity", "id", "tactics", "template", "modified"];

/** `--fields` accepts the compact connector keys plus the full-row safe metadata. */
const CONNECTOR_FIELD_ALLOWLIST = ["name", "kind", "types", "id", "tenant", "subscriptionId", "modified"];

interface AlertRuleProperties {
  displayName?: string;
  description?: string;
  severity?: string;
  enabled?: boolean;
  tactics?: string[];
  query?: string;
  alertRuleTemplateName?: string;
  lastModifiedUtc?: string;
}

interface AlertRule {
  id?: string;
  name?: string;
  kind?: string;
  properties?: AlertRuleProperties;
}

interface DataConnectorProperties {
  tenantId?: string;
  subscriptionId?: string;
  lastModifiedUtc?: string;
  dataTypes?: Record<string, unknown>;
}

interface DataConnector {
  id?: string;
  name?: string;
  kind?: string;
  properties?: DataConnectorProperties;
}

function compactAlertRuleRow(rule: AlertRule): Record<string, unknown> {
  const properties = rule.properties ?? {};
  return {
    name: rule.name ?? "",
    rule: properties.displayName ?? "",
    kind: rule.kind ?? "",
    enabled: properties.enabled ?? "",
    severity: properties.severity ?? "",
  };
}

function fullAlertRuleRow(rule: AlertRule): Record<string, unknown> {
  const properties = rule.properties ?? {};
  return {
    ...compactAlertRuleRow(rule),
    id: rule.id ?? "",
    tactics: properties.tactics ?? [],
    template: properties.alertRuleTemplateName ?? "",
    modified: properties.lastModifiedUtc ?? "",
  };
}

/** `alerts:Enabled, incidents:Enabled`, sorted; only names and states are read. */
function connectorTypes(properties: DataConnectorProperties | undefined): string {
  const dataTypes = properties?.dataTypes;
  if (!dataTypes || typeof dataTypes !== "object") return "";
  return Object.entries(dataTypes)
    .map(([name, entry]) => {
      const state = typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>)["state"]
        : undefined;
      return typeof state === "string" && state ? `${name}:${state}` : name;
    })
    .sort()
    .join(", ");
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function compactConnectorRow(connector: DataConnector): Record<string, unknown> {
  return {
    name: connector.name ?? "",
    kind: connector.kind ?? "",
    types: connectorTypes(connector.properties),
  };
}

function fullConnectorRow(connector: DataConnector): Record<string, unknown> {
  const properties = connector.properties ?? {};
  return {
    ...compactConnectorRow(connector),
    id: connector.id ?? "",
    tenant: safeText(properties.tenantId),
    subscriptionId: safeText(properties.subscriptionId),
    modified: safeText(properties.lastModifiedUtc),
  };
}

function collectionBase(target: WorkspaceTarget, collection: "alertRules" | "dataConnectors"): string {
  return `/subscriptions/${target.subscription}/resourceGroups/${segment(target.resourceGroup, "resource-group")}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${segment(target.workspaceName, "workspace-name")}` +
    `/providers/Microsoft.SecurityInsights/${collection}`;
}

/** Pure selector validation for the rule/connector verbs: no transport, so
 * unknown or conflicting selectors fail before any dependency call. */
function collectionSelectorError(
  args: ReturnType<typeof parseArgs>,
  noun: "alert-rule" | "data-connector",
  verb: "list" | "show",
): string | undefined {
  const ids = flagText(args, "ids");
  const workspaceName = flagText(args, "workspace-name");
  const group = flagText(args, "resource-group");
  const workspace = flagText(args, "workspace");
  if (ids) {
    if (verb === "list") return `${noun} list takes no --ids; use \`sentinel ${noun} show --ids <${noun}-ARM-id>\``;
    if (workspaceName || group || workspace) return `--ids selects the ${noun} itself; workspace selectors are not accepted with --ids`;
    return undefined;
  }
  if (workspace && (workspaceName || group)) return "--workspace conflicts with --workspace-name and --resource-group";
  if (!workspace && !(workspaceName && group)) {
    return verb !== "list"
      ? `${noun} ${verb} needs --name <id> with --workspace-name and --resource-group, --workspace <alias|guid>, or --ids <${noun}-ARM-id>`
      : `${noun} ${verb} needs --workspace-name and --resource-group, or --workspace <alias|guid>`;
  }
  // Path-segment shape is pure: reject it before any subscription transport.
  if (workspaceName) segment(workspaceName, "workspace-name");
  if (group) segment(group, "resource-group");
  return undefined;
}

interface CollectionScope {
  subscription: string;
  target: WorkspaceTarget;
  suffix: string;
}

/** Exactly one subscription plus the workspace target both list verbs and
 * name-selected show verbs share. */
async function resolveCollectionScope(
  profile: ResolvedProfile,
  args: ReturnType<typeof parseArgs>,
  noun: string,
): Promise<CollectionScope> {
  // Alias existence is profile-local: reject unknown workspaces before transport.
  const workspaceFlag = flagText(args, "workspace");
  if (workspaceFlag) workspaceGuid(profile, workspaceFlag);
  const ids = await subscriptions(profile);
  if (ids.length !== 1) invalid(`${noun} needs exactly one subscription; use --subscription <id>`);
  const target = await resolveWorkspace(profile, args, ids[0]!);
  return { subscription: ids[0]!, target, suffix: selectorSuffix(args, ids[0]!, target) };
}

function enabledLabel(enabled: boolean | undefined): string {
  if (enabled === true) return "Enabled";
  if (enabled === false) return "Disabled";
  return "(unknown)";
}

async function runAlertRuleList(profile: ResolvedProfile, args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !RULE_FIELD_ALLOWLIST.includes(field))) {
    invalid(`alert-rule list --fields supports only: ${RULE_FIELD_ALLOWLIST.join(", ")}`);
  }
  const limit = limitValue(args);
  const selectors = collectionSelectorError(args, "alert-rule", "list");
  if (selectors) invalid(selectors);

  const { target, suffix } = await resolveCollectionScope(profile, args, "alert-rule list");

  const page = await requestAll<AlertRule>(profile,
    { method: "GET", path: collectionBase(target, "alertRules"), apiVersion: SENTINEL_ALERT_RULES });
  const collected = page.items
    .sort((a, b) => (a.properties?.displayName ?? a.name ?? "").localeCompare(b.properties?.displayName ?? b.name ?? ""));

  const scopeHint = `in workspace ${target.workspaceName}`;
  if (collected.length === 0) {
    return {
      profile: profile.name,
      workspace: target.workspaceName,
      total: page.nextLink ? "0+" : 0,
      count: countLine(0, 0, "alert rules"),
      rows: emptyState("alert rules", page.nextLink ? `${scopeHint} in fetched pages; search is incomplete` : scopeHint),
      help: [
        `Run \`az-axi sentinel alert-rule show --name <rule-id>${suffix}\` for a rule in detail`,
        ...(page.nextLink ? ["More pages exist; paging stopped at 10 pages. Counts are lower bounds."] : []),
      ],
    };
  }

  const byKind: Record<string, number> = {};
  const byEnabled: Record<string, number> = {};
  for (const rule of collected) {
    const kind = rule.kind || "(unknown)";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const state = enabledLabel(rule.properties?.enabled);
    byEnabled[state] = (byEnabled[state] ?? 0) + 1;
  }

  const shown = (full ? collected : collected.slice(0, limit)).map(full || fields ? fullAlertRuleRow : compactAlertRuleRow);
  const picked = pickFields(shown, fields);
  const first = collected[0]!;
  const help: string[] = [
    `Run \`az-axi sentinel alert-rule show --name ${first.name ?? ""}${suffix}\` for the first rule in detail`,
  ];
  if (shown.length < collected.length) {
    help.push(`Run \`az-axi sentinel alert-rule list${suffix} --full\` to show every fetched row`);
  }
  if (page.nextLink) {
    help.push("More pages exist; paging stopped at 10 pages. Counts are lower bounds.");
  }
  return {
    profile: profile.name,
    workspace: target.workspaceName,
    total: page.nextLink ? `${collected.length}+` : collected.length,
    count: countLine(shown.length, collected.length, "alert rules"),
    byKind,
    byEnabled,
    rows: picked,
    help,
  };
}

async function runAlertRuleShow(profile: ResolvedProfile, args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const name = flagText(args, "name");
  const ids = flagText(args, "ids");
  if (name && ids) invalid("alert-rule show takes --name or --ids, not both");
  if (!name && !ids) invalid("alert-rule show needs --name <rule-id> or --ids <rule-ARM-id>");
  const selectors = collectionSelectorError(args, "alert-rule", "show");
  if (selectors) invalid(selectors);
  if (name) segment(name.trim(), "name");
  const workspaceFlag = flagText(args, "workspace");
  if (workspaceFlag) workspaceGuid(profile, workspaceFlag);

  let rule: AlertRule;
  let target: WorkspaceTarget | undefined;
  let subscription: string;
  let suffix: string;
  if (ids) {
    const match = ALERT_RULE_ID.exec(ids.trim());
    if (!match) invalid("--ids must be one alert-rule ARM ID under Microsoft.SecurityInsights/alertRules");
    subscription = match[1]!;
    if (!GUID.test(subscription)) invalid("--ids must carry a subscription GUID");
    const selected = profile.subscriptions?.length ? await subscriptions(profile) : [subscription];
    if (!selected.some((id) => id.toLowerCase() === subscription.toLowerCase())) {
      invalid("--ids conflicts with selected subscriptions");
    }
    suffix = selectorSuffix(args, subscription, undefined);
    rule = await request<AlertRule>(profile, {
      method: "GET",
      path: `/subscriptions/${subscription}/resourceGroups/${segment(match[2]!, "ids")}` +
        `/providers/Microsoft.OperationalInsights/workspaces/${segment(match[3]!, "ids")}` +
        `/providers/Microsoft.SecurityInsights/alertRules/${match[4]!}`,
      apiVersion: SENTINEL_ALERT_RULES,
    });
  } else {
    const scope = await resolveCollectionScope(profile, args, "alert-rule show");
    subscription = scope.subscription;
    target = scope.target;
    suffix = scope.suffix;
    rule = await request<AlertRule>(profile, {
      method: "GET",
      path: `${collectionBase(target, "alertRules")}/${segment(name!.trim(), "name")}`,
      apiVersion: SENTINEL_ALERT_RULES,
    });
  }

  const properties = rule.properties ?? {};
  const description = properties.description ?? "";
  const descriptionText = full ? { text: description, truncated: false } : truncate(description, CELL_TRUNCATE);
  const queryText = properties.query === undefined
    ? undefined
    : full ? { text: properties.query, truncated: false } : truncate(properties.query, CELL_TRUNCATE);
  const help: string[] = [];
  if (!full && (descriptionText.truncated || queryText?.truncated)) {
    const selector = ids ? `--ids ${rule.id ?? ids.trim()}` : `--name ${rule.name ?? name!.trim()}`;
    help.push(`Run \`az-axi sentinel alert-rule show ${selector}${suffix} --full\` for the complete description and query`);
  }

  const workspaceFromId = (rule.id ?? "").split("/workspaces/")[1]?.split("/")[0] ?? "";
  return {
    profile: profile.name,
    workspace: target?.workspaceName ?? workspaceFromId,
    name: rule.name ?? "",
    id: rule.id ?? "",
    rule: properties.displayName ?? "",
    kind: rule.kind ?? "",
    enabled: properties.enabled ?? "",
    severity: properties.severity ?? "",
    description: descriptionText.text,
    tactics: properties.tactics ?? [],
    template: properties.alertRuleTemplateName ?? "",
    modified: properties.lastModifiedUtc ?? "",
    ...(queryText === undefined ? {} : { query: queryText.text }),
    subscription: parseSubscriptionId(rule.id ?? "") ?? subscription,
    ...(help.length > 0 ? { help } : {}),
  };
}

async function runDataConnectorList(profile: ResolvedProfile, args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !CONNECTOR_FIELD_ALLOWLIST.includes(field))) {
    invalid(`data-connector list --fields supports only: ${CONNECTOR_FIELD_ALLOWLIST.join(", ")}`);
  }
  const limit = limitValue(args);
  const selectors = collectionSelectorError(args, "data-connector", "list");
  if (selectors) invalid(selectors);

  const { target, suffix } = await resolveCollectionScope(profile, args, "data-connector list");

  const page = await requestAll<DataConnector>(profile,
    { method: "GET", path: collectionBase(target, "dataConnectors"), apiVersion: SENTINEL_DATA_CONNECTORS });
  const collected = page.items
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  const scopeHint = `in workspace ${target.workspaceName}`;
  if (collected.length === 0) {
    return {
      profile: profile.name,
      workspace: target.workspaceName,
      total: page.nextLink ? "0+" : 0,
      count: countLine(0, 0, "data connectors"),
      rows: emptyState("data connectors", page.nextLink ? `${scopeHint} in fetched pages; search is incomplete` : scopeHint),
      help: [
        `Run \`az-axi sentinel data-connector show --name <connector-id>${suffix}\` for a connector in detail`,
        ...(page.nextLink ? ["More pages exist; paging stopped at 10 pages. Counts are lower bounds."] : []),
      ],
    };
  }

  const byKind: Record<string, number> = {};
  for (const connector of collected) {
    const kind = connector.kind || "(unknown)";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }

  const shown = (full ? collected : collected.slice(0, limit)).map(full || fields ? fullConnectorRow : compactConnectorRow);
  const picked = pickFields(shown, fields);
  const first = collected[0]!;
  const help: string[] = [
    `Run \`az-axi sentinel data-connector show --name ${first.name ?? ""}${suffix}\` for the first connector in detail`,
  ];
  if (shown.length < collected.length) {
    help.push(`Run \`az-axi sentinel data-connector list${suffix} --full\` to show every fetched row`);
  }
  if (page.nextLink) {
    help.push("More pages exist; paging stopped at 10 pages. Counts are lower bounds.");
  }
  return {
    profile: profile.name,
    workspace: target.workspaceName,
    total: page.nextLink ? `${collected.length}+` : collected.length,
    count: countLine(shown.length, collected.length, "data connectors"),
    byKind,
    rows: picked,
    help,
  };
}

async function runDataConnectorShow(profile: ResolvedProfile, args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const name = flagText(args, "name");
  const ids = flagText(args, "ids");
  if (name && ids) invalid("data-connector show takes --name or --ids, not both");
  if (!name && !ids) invalid("data-connector show needs --name <connector-id> or --ids <connector-ARM-id>");
  const selectors = collectionSelectorError(args, "data-connector", "show");
  if (selectors) invalid(selectors);
  if (name) segment(name.trim(), "name");
  const workspaceFlag = flagText(args, "workspace");
  if (workspaceFlag) workspaceGuid(profile, workspaceFlag);

  let connector: DataConnector;
  let target: WorkspaceTarget | undefined;
  let subscription: string;
  if (ids) {
    const match = DATA_CONNECTOR_ID.exec(ids.trim());
    if (!match) invalid("--ids must be one data-connector ARM ID under Microsoft.SecurityInsights/dataConnectors");
    subscription = match[1]!;
    if (!GUID.test(subscription)) invalid("--ids must carry a subscription GUID");
    const selected = profile.subscriptions?.length ? await subscriptions(profile) : [subscription];
    if (!selected.some((id) => id.toLowerCase() === subscription.toLowerCase())) {
      invalid("--ids conflicts with selected subscriptions");
    }
    connector = await request<DataConnector>(profile, {
      method: "GET",
      path: `/subscriptions/${subscription}/resourceGroups/${segment(match[2]!, "ids")}` +
        `/providers/Microsoft.OperationalInsights/workspaces/${segment(match[3]!, "ids")}` +
        `/providers/Microsoft.SecurityInsights/dataConnectors/${match[4]!}`,
      apiVersion: SENTINEL_DATA_CONNECTORS,
    });
  } else {
    const scope = await resolveCollectionScope(profile, args, "data-connector show");
    subscription = scope.subscription;
    target = scope.target;
    connector = await request<DataConnector>(profile, {
      method: "GET",
      path: `${collectionBase(target, "dataConnectors")}/${segment(name!.trim(), "name")}`,
      apiVersion: SENTINEL_DATA_CONNECTORS,
    });
  }

  // Only safelisted metadata leaves this function: tenant and subscription IDs,
  // data-type states and timestamps. Anything else the service returns -
  // secrets, keys, credential fields - is never projected.
  const properties = connector.properties ?? {};
  const workspaceFromId = (connector.id ?? "").split("/workspaces/")[1]?.split("/")[0] ?? "";
  return {
    profile: profile.name,
    workspace: target?.workspaceName ?? workspaceFromId,
    name: connector.name ?? "",
    id: connector.id ?? "",
    kind: connector.kind ?? "",
    types: connectorTypes(connector.properties),
    tenant: safeText(properties.tenantId),
    subscriptionId: safeText(properties.subscriptionId),
    modified: safeText(properties.lastModifiedUtc),
    subscription: parseSubscriptionId(connector.id ?? "") ?? subscription,
  };
}

/**
 * Native incident writes (slice 10b). Both verbs are PUTs through the shared
 * write pipeline so the write log, LRO handling and approval hook apply.
 * Incident updates merge against the same read used for the diff and ETag;
 * comment creation uses a new generated ID on every invocation.
 */
const UPDATE_STATUSES: Record<string, string> = { new: "New", active: "Active", closed: "Closed" };
const UPDATE_SEVERITIES: Record<string, string> = {
  high: "High", medium: "Medium", low: "Low", informational: "Informational",
};
const UPDATE_CLASSIFICATIONS: Record<string, string> = {
  undetermined: "Undetermined", truepositive: "TruePositive",
  benignpositive: "BenignPositive", falsepositive: "FalsePositive",
};
const UPDATE_CLASSIFICATION_REASONS: Record<string, string> = {
  suspiciousactivity: "SuspiciousActivity", suspiciousbutexpected: "SuspiciousButExpected",
  incorrectalertlogic: "IncorrectAlertLogic", inaccuratedata: "InaccurateData",
};
const UPDATE_PROTECTION =
  "compare-and-swap on the incident ETag (re-read before send; --if-match pins a reviewed value)";
const COMMENT_PROTECTION =
  "new generated comment ID, so there is no current state to compare";

function writeInvalid(leaf: string, message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", [`Run \`az-axi ${leaf} --help\``]);
}

/** Exactly one explicit subscription GUID: names and implicit env/profile scope are refused. */
function explicitSubscription(args: ReturnType<typeof parseArgs>, leaf: string): string {
  if (flagText(args, "management-group")) {
    throw new AxiError("incident writes require one subscription, not a management group", "VALIDATION_ERROR", [
      "Pass --subscription <id>",
    ]);
  }
  const subs = flagList(args, "subscription");
  if (subs?.length !== 1 || !GUID.test(subs[0]!)) {
    throw new AxiError("incident writes require exactly one explicit subscription ID", "VALIDATION_ERROR", [
      "Pass --subscription <id> from `az-axi sub list`; names and batches are not supported",
      `Run \`az-axi ${leaf} --help\``,
    ]);
  }
  return subs[0]!;
}

interface IncidentSelection {
  incidentId: string;
  /** Bare incident ARM path, without query string. */
  path: string;
  /** Defined unless the incident came from --ids; echoed into execute hints. */
  target: WorkspaceTarget | undefined;
}

/**
 * Resolves --name/--incident-id (GUID or number, with workspace selectors) or
 * --ids to one incident path. The explicit subscription must agree with --ids.
 */
async function resolveIncidentTarget(
  profile: ResolvedProfile,
  args: ReturnType<typeof parseArgs>,
  subscription: string,
  ref: { name: string } | { ids: string },
  label: string,
): Promise<IncidentSelection> {
  const bad = (message: string): never => writeInvalid(`sentinel incident ${label}`, message);
  const selectors = selectorError(args, "show", label);
  if (selectors) bad(selectors);
  if ("ids" in ref) {
    const match = INCIDENT_ID.exec(ref.ids.trim());
    if (match) {
      if (!GUID.test(match[1]!)) bad("--ids must carry a subscription GUID");
      if (match[1]!.toLowerCase() !== subscription.toLowerCase()) bad("--ids conflicts with --subscription <id>");
      if (!GUID.test(match[4]!)) bad("--ids must end in the incident GUID");
      return {
        incidentId: match[4]!,
        path: `/subscriptions/${subscription}/resourceGroups/${segment(match[2]!, "ids")}` +
          `/providers/Microsoft.OperationalInsights/workspaces/${segment(match[3]!, "ids")}` +
          `/providers/Microsoft.SecurityInsights/incidents/${match[4]!}`,
        target: undefined,
      };
    }
    return bad("--ids must be one incident ARM ID under Microsoft.SecurityInsights/incidents");
  }
  const target = await resolveWorkspace(profile, args, subscription);
  const base = incidentBase(target.subscription, target.resourceGroup, target.workspaceName);
  const raw = ref.name.trim();
  if (NUMBER.test(raw)) {
    const found = await listForNumber(profile, target, Number(raw),
      `az-axi sentinel incident list${selectorSuffix(args, subscription, target)}`);
    const id = found.id ?? `${base}/${found.name ?? raw}`;
    const guid = /\/incidents\/([^/]+)$/i.exec(id)?.[1] ?? "";
    if (!GUID.test(guid)) bad("the incident lookup returned an unexpected resource ID");
    return { incidentId: guid, path: id, target };
  }
  return { incidentId: raw, path: `${base}/${raw}`, target };
}

function enumFlag(
  args: ReturnType<typeof parseArgs>,
  leaf: string,
  name: string,
  table: Record<string, string>,
  message: string,
): string | undefined {
  const raw = flagText(args, name);
  if (raw === undefined) return undefined;
  const key = raw.toLowerCase();
  if (!Object.hasOwn(table, key)) writeInvalid(leaf, message);
  return table[key];
}

/** One identity: a GUID becomes objectId, text with @ becomes email, else the assigned-to name. */
function ownerInfo(raw: string, current: IncidentOwner | undefined): IncidentOwner {
  const value = raw.trim();
  if (GUID.test(value)) {
    return current?.objectId?.toLowerCase() === value.toLowerCase() ? current : { objectId: value };
  }
  if (value.includes("@")) {
    if (current && [current.email, current.userPrincipalName].some((identity) => identity?.toLowerCase() === value.toLowerCase())) return current;
    return { email: value, userPrincipalName: value };
  }
  if (current?.assignedTo === value) return current;
  return { assignedTo: value };
}

function gateSelectorFlags(args: ReturnType<typeof parseArgs>): string {
  return ["profile", "tenant", "config"]
    .map((key) => flagText(args, key) === undefined ? "" : formatFlagValue(key, flagText(args, key)!))
    .filter(Boolean).join(" ");
}

/**
 * Refuses before any transport: profile and subscription gates need only the
 * subscription scope, so a refused write never sends even the merge-GET.
 * The exact request is re-gated by the client backstop at send time.
 */
function refuseBeforeTransport(
  profile: ResolvedProfile,
  args: ReturnType<typeof parseArgs>,
  subscription: string,
): boolean {
  const scope = { resource: "arm" as const, method: "PUT", path: `/subscriptions/${subscription}` };
  const cls = classifyRequest(scope);
  assertReadOnlyBoundary(scope, cls);
  return enforceGates(profile, scope, cls, { execute: flagBool(args, "execute") });
}

async function runUpdate(profile: ResolvedProfile, args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const leaf = "sentinel incident update";
  const bad = (message: string): never => writeInvalid(leaf, message);
  const subscription = explicitSubscription(args, leaf);
  const nameFlag = flagText(args, "name");
  const incidentIdFlag = flagText(args, "incident-id");
  if (nameFlag && incidentIdFlag && nameFlag.trim() !== incidentIdFlag.trim()) bad("--name conflicts with --incident-id");
  const name = nameFlag ?? incidentIdFlag;
  const ids = flagText(args, "ids");
  if (name && ids) bad("incident update takes --name or --ids, not both");
  if (!name && !ids) bad("incident update needs --name <incident-id|number> or --ids <incident-ARM-id>");
  if (name && !NUMBER.test(name.trim()) && !GUID.test(name.trim())) {
    bad("--name must be the incident GUID or its incident number; full ARM IDs need --ids");
  }

  const status = enumFlag(args, leaf, "status", UPDATE_STATUSES, "--status must be New, Active or Closed");
  const severity = enumFlag(args, leaf, "severity", UPDATE_SEVERITIES, "--severity must be High, Medium, Low or Informational");
  const owner = flagText(args, "owner");
  const classification = enumFlag(args, leaf, "classification", UPDATE_CLASSIFICATIONS,
    "--classification must be Undetermined, TruePositive, BenignPositive or FalsePositive");
  const classificationReason = enumFlag(args, leaf, "classification-reason", UPDATE_CLASSIFICATION_REASONS,
    "--classification-reason must be SuspiciousActivity, SuspiciousButExpected, IncorrectAlertLogic or InaccurateData");
  const classificationComment = flagText(args, "classification-comment");
  if (!status && !severity && !owner && !classification) {
    bad("incident update needs at least one of --status, --severity, --owner or --classification");
  }
  if (status === "Closed" && !classification) bad("closing an incident (--status Closed) requires --classification");
  if ((classificationReason || classificationComment) && !classification) {
    bad("--classification-reason and --classification-comment require --classification");
  }
  if (classification && classification !== "Undetermined" && !classificationReason) {
    bad(`classification ${classification} requires --classification-reason`);
  }
  const execute = refuseBeforeTransport(profile, args, subscription);

  const selection = await resolveIncidentTarget(profile, args, subscription,
    name ? { name } : { ids: ids! }, "update");
  const suffix = selectorSuffix(args, subscription, selection.target);

  const overlay: IncidentProperties = {};
  if (status) overlay.status = status;
  if (severity) overlay.severity = severity;
  if (classification) {
    overlay.classification = classification;
    if (classificationReason) overlay.classificationReason = classificationReason;
    if (classificationComment) overlay.classificationComment = classificationComment;
  }
  const mergeBody = (value: unknown) => {
    const current = value as Incident;
    return { ...current, properties: { ...(current.properties ?? {}), ...overlay,
      ...(owner ? { owner: ownerInfo(owner, current.properties?.owner) } : {}) } };
  };

  const shape = { resource: "arm" as const, method: "PUT", path: selection.path };
  const cls = classifyRequest(shape);
  assertReadOnlyBoundary(shape, cls);
  const ifMatch = flagText(args, "if-match");
  const timeoutMs = parseTimeoutFlag(flagText(args, "timeout"));
  const selectors = gateSelectorFlags(args);
  const workspaceFlags = ids ? [] : flagText(args, "workspace") !== undefined
    ? [formatFlagValue("workspace", flagText(args, "workspace")!)]
    : [formatFlagValue("resource-group", selection.target!.resourceGroup),
      formatFlagValue("workspace-name", selection.target!.workspaceName)];
  const command = (etag: string | undefined) => ["az-axi sentinel incident update", selectors, formatFlagValue("subscription", subscription),
    ...(ids ? [formatFlagValue("ids", ids.trim())]
      : [formatFlagValue("name", name!.trim()), ...workspaceFlags]),
    ...(status === undefined ? [] : [formatFlagValue("status", status)]),
    ...(severity === undefined ? [] : [formatFlagValue("severity", severity)]),
    ...(owner === undefined ? [] : [formatFlagValue("owner", owner)]),
    ...(classification === undefined ? [] : [formatFlagValue("classification", classification)]),
    ...(classificationReason === undefined ? [] : [formatFlagValue("classification-reason", classificationReason)]),
    ...(classificationComment === undefined ? [] : [formatFlagValue("classification-comment", classificationComment)]),
    ...(etag === undefined ? [] : [formatFlagValue("if-match", etag)]),
    ...(flagText(args, "timeout") === undefined ? [] : [formatFlagValue("timeout", flagText(args, "timeout")!)]),
    ...(flagBool(args, "no-wait") ? ["--no-wait"] : []), "--execute"].filter(Boolean).join(" ");
  if (execute) {
    return executeWrite({ profile, method: "PUT", path: buildUrl({ path: selection.path, apiVersion: SENTINEL_INCIDENTS }),
      cls: "write", body: undefined, mergeBody, protection: UPDATE_PROTECTION, ifMatch,
      selectors, timeoutMs, noWait: flagBool(args, "no-wait") });
  }
  const preview = await dryRun({ profile, resource: "arm", method: "PUT", path: selection.path, cls,
    body: undefined, mergeBody, apiVersion: SENTINEL_INCIDENTS, ifMatch, selectors, full: flagBool(args, "full") });
  return { ...preview, protection: UPDATE_PROTECTION,
    help: [`\`${command(typeof preview.etag === "string" ? preview.etag : ifMatch)}\``] };
}

async function runCommentCreate(profile: ResolvedProfile, args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const leaf = "sentinel incident comment create";
  const bad = (message: string): never => writeInvalid(leaf, message);
  const subscription = explicitSubscription(args, leaf);
  const message = flagText(args, "message");
  if (!message) bad("incident comment create needs --message <text>");
  const incidentIdFlag = flagText(args, "incident-id");
  const ids = flagText(args, "ids");
  if (incidentIdFlag && ids) bad("incident comment create takes --incident-id or --ids, not both");
  if (!incidentIdFlag && !ids) bad("incident comment create needs --incident-id <incident-id|number> or --ids <incident-ARM-id>");
  if (incidentIdFlag && !NUMBER.test(incidentIdFlag.trim()) && !GUID.test(incidentIdFlag.trim())) {
    bad("--incident-id must be the incident GUID or its incident number; full ARM IDs need --ids");
  }
  const commentId = randomUUID();
  const execute = refuseBeforeTransport(profile, args, subscription);

  const selection = await resolveIncidentTarget(profile, args, subscription,
    incidentIdFlag ? { name: incidentIdFlag } : { ids: ids! }, "comment create");
  const path = `${selection.path}/comments/${commentId}`;
  const body = { properties: { message: message! } };

  const shape = { resource: "arm" as const, method: "PUT", path };
  const cls = classifyRequest(shape);
  assertReadOnlyBoundary(shape, cls);
  const timeoutMs = parseTimeoutFlag(flagText(args, "timeout"));
  const selectors = gateSelectorFlags(args);
  const workspaceFlags = ids ? [] : flagText(args, "workspace") !== undefined
    ? [formatFlagValue("workspace", flagText(args, "workspace")!)]
    : [formatFlagValue("resource-group", selection.target!.resourceGroup),
      formatFlagValue("workspace-name", selection.target!.workspaceName)];
  const command = ["az-axi sentinel incident comment create", selectors, formatFlagValue("subscription", subscription),
    ...(ids ? [formatFlagValue("ids", ids.trim())]
      : [formatFlagValue("incident-id", incidentIdFlag!.trim()), ...workspaceFlags]),
    formatFlagValue("message", message!),
    ...(flagText(args, "timeout") === undefined ? [] : [formatFlagValue("timeout", flagText(args, "timeout")!)]),
    ...(flagBool(args, "no-wait") ? ["--no-wait"] : []), "--execute"].filter(Boolean).join(" ");
  if (execute) {
    return executeWrite({ profile, method: "PUT", path: buildUrl({ path, apiVersion: SENTINEL_INCIDENTS }),
      cls: "write", body, protection: COMMENT_PROTECTION,
      selectors, timeoutMs, noWait: flagBool(args, "no-wait") });
  }
  const preview = await dryRun({ profile, resource: "arm", method: "PUT", path, cls,
    body, apiVersion: SENTINEL_INCIDENTS, selectors, full: flagBool(args, "full") });
  return { ...preview, protection: COMMENT_PROTECTION,
    help: [`\`${command}\``] };
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const group = args.positionals[0];
  if (group === "alert-rule" || group === "data-connector") {
    const verb = args.positionals[1];
    const tail = args.positionals.slice(2);
    const leaf = (verb === "list" || verb === "show") && tail.length === 0 ? `sentinel ${group} ${verb}` : undefined;
    if (!leaf) {
      throw new AxiError(
        verb ? `unknown command \`sentinel ${[group, verb, ...tail].join(" ")}\`` : `missing verb for \`sentinel ${group}\``,
        "VALIDATION_ERROR",
        ["Expected one of: list | show", `Run \`az-axi sentinel ${group} list --help\` for usage`],
      );
    }
    assertKnownFlags(args, commandFlags(leaf), leaf);
    const profile = profileFromArgs(args);
    if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
      invalid("management-group scope is unsupported for Sentinel analytics rules and connectors; select one subscription explicitly");
    }
    if (leaf === "sentinel alert-rule list") return runAlertRuleList(profile, args);
    if (leaf === "sentinel alert-rule show") return runAlertRuleShow(profile, args);
    if (leaf === "sentinel data-connector list") return runDataConnectorList(profile, args);
    return runDataConnectorShow(profile, args);
  }
  if (args.positionals[0] !== "incident") {
    throw new AxiError(
      args.positionals[0] ? `unknown command \`sentinel ${args.positionals[0]}\`` : "missing subcommand for `sentinel`",
      "VALIDATION_ERROR",
      ["Run `az-axi sentinel incident list|show --help` for usage"],
    );
  }
  const verb = args.positionals[1];
  const tail = args.positionals.slice(2);
  let leaf: string;
  if ((verb === "list" || verb === "show" || verb === "list-alert" || verb === "list-entity" || verb === "update") && tail.length === 0) {
    leaf = `sentinel incident ${verb}`;
  } else if (verb === "comment" && tail.length === 1 && tail[0] === "create") {
    leaf = "sentinel incident comment create";
  } else if (verb === "list" || verb === "show" || verb === "list-alert" || verb === "list-entity" || verb === "update") {
    throw new AxiError(`unexpected argument \`${tail[0]}\` for \`sentinel incident ${verb}\``, "VALIDATION_ERROR", [
      `Run \`az-axi sentinel incident ${verb} --help\` for usage`,
    ]);
  } else {
    throw new AxiError(
      verb ? `unknown command \`sentinel incident ${[verb, ...tail].join(" ")}\`` : "missing verb for `sentinel incident`",
      "VALIDATION_ERROR",
      ["Expected one of: list | show | list-alert | list-entity | update | comment create", "Run `az-axi sentinel incident list --help` for usage"],
    );
  }
  assertKnownFlags(args, commandFlags(leaf), leaf);
  const profile = profileFromArgs(args);
  if (leaf === "sentinel incident list" || leaf === "sentinel incident show" || leaf === "sentinel incident list-alert" || leaf === "sentinel incident list-entity") {
    if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
      invalid("management-group scope is unsupported for Sentinel incidents; select one subscription explicitly");
    }
  }
  if (leaf === "sentinel incident list") return runList(profile, args);
  if (leaf === "sentinel incident show") return runShow(profile, args);
  if (leaf === "sentinel incident list-alert") return runAlertList(profile, args);
  if (leaf === "sentinel incident list-entity") return runEntityList(profile, args);
  // The module effect stays read so incident reads keep the read-only request
  // guard; each write verb elevates to the write effect for its own requests.
  if (leaf === "sentinel incident update") return runWithEffect("write", () => runUpdate(profile, args));
  return runWithEffect("write", () => runCommentCreate(profile, args));
}
