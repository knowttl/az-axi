import { AxiError } from "axi-sdk-js";
import { LOG_ANALYTICS_WORKSPACES, RESOURCE_GROUPS, SUBSCRIPTIONS_LIST } from "./apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagText, parseArgs } from "./args.js";
import { request, requestAll } from "./client.js";
import { profileFromArgs, subcommandOf } from "./context.js";
import type { ResolvedProfile } from "./config.js";
import { emptyState, pickFields } from "./format.js";
import { commandFlags } from "./registry.js";
import { SECRET_ACTIONS } from "./policy.js";
import { formatFlagValue } from "./shell.js";

interface ArmItem extends Record<string, unknown> {
  id: string;
  name: string;
  type?: string;
  location?: string;
  identity?: { type?: string };
  properties?: { provisioningState?: string };
}
const WORKSPACE_FIELDS = ["name", "id", "type", "location", "tags", "customerId", "state", "retentionInDays", "sku", "publicNetworkAccessForIngestion", "publicNetworkAccessForQuery"];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_SHOW_FIELDS = ["id", "name", "type", "kind", "location", "tags", "sku", "identity", "provisioningState"];

function invalid(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `az-axi group show --help` or `az-axi resource show --help` for selectors"]);
}

function segment(value: string): string {
  if (/[/%?#\\]/.test(value) || value === "." || value === "..") invalid("selector must be a single ARM path segment");
  return encodeURIComponent(value);
}

export async function subscriptions(profile: ResolvedProfile, available?: { items: Array<{ subscriptionId: string; displayName: string }>; nextLink?: string }): Promise<string[]> {
  const selected = profile.subscriptions;
  if (selected?.length && selected.every((s) => GUID.test(s))) return [...new Set(selected.map((s) => s.toLowerCase()))];
  const { items, nextLink } = available ?? await requestAll<{ subscriptionId: string; displayName: string }>(profile,
    { method: "GET", path: "/subscriptions", apiVersion: SUBSCRIPTIONS_LIST }, 100);
  if (nextLink && (!available || selected?.some((id) => !GUID.test(id)))) invalid("subscription discovery is incomplete; select explicit subscription IDs");
  if (!selected?.length) return [...new Set(items.map((s) => s.subscriptionId))];
  return [...new Set(selected.map((value) => {
    if (GUID.test(value)) return value.toLowerCase();
    const matches = items.filter((s) => s.displayName.toLowerCase() === value.toLowerCase());
    if (matches.length !== 1) invalid(`subscription name '${value}' matched ${matches.length} subscriptions; use an ID`);
    return matches[0]!.subscriptionId;
  }))];
}

function resourceId(value: string): { id: string; subscription: string; namespace: string; type: string } {
  if (/[?#%\\]/.test(value)) invalid("--ids requires an unescaped ARM resource ID without a query or fragment");
  const match = /^\/subscriptions\/([^/]+)\/(?:resourceGroups\/([^/]+)\/)?providers\/([^/]+)\/(.+)$/i.exec(value);
  const tail = match?.[4]?.split("/") ?? [];
  if (!match || !GUID.test(match[1]!) || tail.length < 2 || tail.length % 2 || tail.some((s) => !s || s === "." || s === "..")) {
    invalid("--ids requires exactly one full ARM resource ID with type/name pairs");
  }
  const types = tail.filter((_s, i) => i % 2 === 0);
  segment(match[3]!);
  if (match[2]) segment(match[2]);
  // Generic provider GETs can return credential values. Refuse these families
  // before version discovery or fetching, even if the caller requests fewer fields.
  const unsafe = new Set(["config", "secrets", "keys", "credentials", "connectionstrings", "publishingcredentials", "host", "functions", "providers", "keyvalues"]);
  // Automation variable GET returns a value, and connection GET returns fields
  // that can contain credentials. Neither is inventory metadata.
  // https://learn.microsoft.com/en-us/rest/api/automation/variable/get
  const automationValues = match[3]!.toLowerCase() === "microsoft.automation" && types.some((s) => ["variables", "connections"].includes(s.toLowerCase()));
  if (automationValues || types.some((s) => unsafe.has(s.toLowerCase())) || types.some((s) => SECRET_ACTIONS.some((action) => action.toLowerCase() === s.toLowerCase()))) {
    throw new AxiError("blocked: resource show does not retrieve credential-bearing child resources or actions", "READ_ONLY", ["Use `az-axi resource list` for inventory metadata"]);
  }
  return { id: value.split("/").map(encodeURIComponent).join("/"), subscription: match[1]!, namespace: match[3]!, type: types.join("/") };
}

function workspaceMetadata(item: ArmItem): Record<string, unknown> {
  const properties = item.properties as Record<string, unknown> | undefined;
  // Allowlisted metadata only, including in full views and field selection.
  return { ...pickFields([item], ["name", "id", "type", "location", "tags"])[0],
    ...pickFields([properties ?? {}], ["customerId", "retentionInDays", "publicNetworkAccessForIngestion", "publicNetworkAccessForQuery"])[0],
    state: properties?.provisioningState ?? "", sku: (properties?.sku as { name?: string } | undefined)?.name ?? "" };
}

function compact(item: ArmItem, kind: "group" | "resource" | "workspace"): Record<string, unknown> {
  if (kind === "workspace") return pickFields([workspaceMetadata(item)], ["name", "id", "location", "customerId"])[0]!;
  return kind === "group"
    ? { name: item.name, id: item.id, location: item.location ?? "", state: item.properties?.provisioningState ?? "" }
    : { name: item.name, id: item.id, type: item.type ?? "", location: item.location ?? "" };
}

export async function runDiscovery(kind: "group" | "resource" | "workspace", argv: string[]): Promise<Record<string, unknown>> {
  const invalid = (message: string): never => { throw new AxiError(message, "VALIDATION_ERROR", [kind === "workspace" ? "Run `az-axi monitor log-analytics workspace show --help` for selectors" : "Run `az-axi group show --help` or `az-axi resource show --help` for selectors"]); };
  const args = parseArgs(argv);
  const verb = subcommandOf(args, ["list", "show"], kind);
  const command = kind === "workspace" ? "monitor log-analytics workspace" : kind;
  assertKnownFlags(args, commandFlags(`${command} ${verb}`), `${command} ${verb}`);
  if (args.positionals.length !== 1) invalid("unexpected positional argument");
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (kind === "workspace" && fields?.some((field) => !WORKSPACE_FIELDS.includes(field))) invalid(`workspace --fields supports only metadata: ${WORKSPACE_FIELDS.join(", ")}`);
  if (kind === "resource" && verb === "show" && fields?.some((field) => !RESOURCE_SHOW_FIELDS.includes(field))) {
    invalid(`resource show --fields supports only ARM envelope fields: ${RESOURCE_SHOW_FIELDS.join(", ")}; use typed commands or az-axi api for provider details`);
  }
  const limit = flagNumber(args, "limit") ?? 50;
  if (!Number.isInteger(limit) || limit <= 0) invalid("--limit must be a positive integer");
  const nameFlag = flagText(args, "name");
  const workspaceName = flagText(args, "workspace-name");
  if (workspaceName && nameFlag && workspaceName !== nameFlag) invalid("--workspace-name conflicts with --name");
  const name = workspaceName ?? nameFlag;
  const group = flagText(args, "resource-group");
  const type = flagText(args, "resource-type");
  const ids = flagText(args, "ids");
  const apiVersion = flagText(args, "api-version");
  if (name && kind === "group") segment(name);
  if (group) segment(group);
  if (kind === "workspace" && name) segment(name);
  if (kind === "workspace" && verb === "show" && (ids ? !!(name || group) : !(name && group))) invalid("workspace show requires --ids alone, or --workspace-name and --resource-group together");
  if (kind === "workspace" && ids && !/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.OperationalInsights\/workspaces\/[^/]+$/i.test(ids)) invalid("--ids must identify one workspace itself, not a child resource or action");
  let namedResourcePath: string | undefined;
  if (verb === "show") {
    if (kind === "workspace" && !ids) namedResourcePath = `/resourceGroups/${segment(group!)}/providers/Microsoft.OperationalInsights/workspaces/${segment(name!)}`;
    if (kind === "group" && !name) invalid("group show requires --name");
    if (kind === "resource" && (ids ? !!(name || group || type) : !(name && group && type))) {
      invalid("resource show requires --ids alone, or --name, --resource-group and --resource-type together");
    }
    if (kind === "resource" && !ids) {
      const types = type!.split("/");
      const names = name!.split("/");
      if (types.length < 2 || names.length !== types.length - 1) invalid("--name needs one name segment per resource type segment");
      namedResourcePath = `/resourceGroups/${group!}/providers/${types[0]!}/${names.map((n, i) => `${types[i + 1]!}/${n}`).join("/")}`;
      // Validate the type before any subscription-name lookup or provider GET.
      resourceId(`/subscriptions/00000000-0000-0000-0000-000000000000${namedResourcePath}`);
    }
  }
  const target = ids ? resourceId(ids) : undefined;
  const profile = profileFromArgs(args);
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
    invalid("management-group scope is unsupported for discovery; select subscriptions explicitly");
  }
  let subs: string[];
  if (target && !profile.subscriptions?.length) subs = [target.subscription];
  else subs = await subscriptions(profile);
  if (target && !subs.some((s) => s.toLowerCase() === target.subscription.toLowerCase())) invalid("--ids conflicts with selected subscriptions");
  if (verb === "show" && !target && subs.length !== 1) invalid("show by name requires exactly one subscription; use --subscription <id>");

  if (kind === "group" && verb === "show") {
    const item = await request<ArmItem>(profile, { method: "GET", path: `/subscriptions/${subs[0]}/resourceGroups/${segment(name!)}`, apiVersion: RESOURCE_GROUPS });
    return { profile: profile.name, group: pickFields([fields ? { ...item, ...compact(item, kind) } : full ? item : compact(item, kind)], fields)[0] };
  }
  if (kind === "workspace" && verb === "show") {
    const item = await request<ArmItem>(profile, { method: "GET", path: target?.id ?? `/subscriptions/${subs[0]}${namedResourcePath}`, apiVersion: LOG_ANALYTICS_WORKSPACES });
    return { profile: profile.name, workspace: pickFields([full || fields ? workspaceMetadata(item) : compact(item, kind)], fields)[0] };
  }
  const items: ArmItem[] = [];
  let incomplete = false;
  if (verb === "list") {
    for (const sub of subs) {
      const path = `/subscriptions/${sub}${group ? `/resourceGroups/${segment(group)}` : ""}/${kind === "workspace" ? "providers/Microsoft.OperationalInsights/workspaces" : kind === "group" ? "resourcegroups" : "resources"}`;
      const page = await requestAll<ArmItem>(profile, { method: "GET", path, apiVersion: kind === "workspace" ? LOG_ANALYTICS_WORKSPACES : RESOURCE_GROUPS }, 100);
      items.push(...page.items.filter((item) => (!name || item.name.toLowerCase() === name.toLowerCase()) && (!type || item.type?.toLowerCase() === type.toLowerCase())));
      incomplete ||= !!page.nextLink;
    }
  }
  if (verb === "show") {
    const resolved = target ?? resourceId(`/subscriptions/${subs[0]}${namedResourcePath}`);
    let version = apiVersion;
    if (!version) {
      const provider = await request<{ resourceTypes: Array<{ resourceType: string; apiVersions: string[] }> }>(profile,
        { method: "GET", path: `/subscriptions/${resolved.subscription}/providers/${segment(resolved.namespace)}`, apiVersion: RESOURCE_GROUPS });
      version = provider.resourceTypes.find((t) => t.resourceType.toLowerCase() === resolved.type.toLowerCase())?.apiVersions
        .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)).sort().reverse()[0];
      if (!version) invalid("no stable API version found; supply --api-version for this resource type");
    }
    const item = await request<ArmItem>(profile, { method: "GET", path: resolved.id, apiVersion: version });
    const envelope = {
      ...pickFields([item], RESOURCE_SHOW_FIELDS)[0],
      identity: { type: item.identity?.type ?? "" },
      provisioningState: item.properties?.provisioningState ?? "",
    };
    return { profile: profile.name, resource: pickFields([full || fields ? envelope : compact(item, kind)], fields)[0] };
  }
  const shown = items.slice(0, full ? undefined : limit);
  const noun = kind === "workspace" ? "workspaces" : kind === "group" ? "resource groups" : "resources";
  const detailSelectors = kind === "workspace" ? ["profile", "config", "tenant", "subscription"]
    .filter((key) => typeof args.flags[key] === "string")
    .map((key) => ` ${formatFlagValue(key, args.flags[key] as string)}`).join("") : "";
  const selectors = ["profile", "config", "tenant", "subscription", "resource-group", "name", "resource-type"]
    .filter((key) => typeof args.flags[key] === "string")
    .map((key) => kind === "workspace" ? ` ${formatFlagValue(key, args.flags[key] as string)}` : ` --${key} ${JSON.stringify(args.flags[key])}`).join("");
  return {
    profile: profile.name,
    total: incomplete ? `${items.length}+` : items.length,
    count: `${shown.length} of ${items.length}${incomplete ? "+" : ""} ${noun}`,
    rows: shown.length ? pickFields(shown.map((item) => kind === "workspace" ? full || fields ? workspaceMetadata(item) : compact(item, kind) : fields ? { ...item, ...compact(item, kind) } : full ? item : compact(item, kind)), fields) : emptyState(noun, incomplete ? "in fetched pages; listing is incomplete" : "in selected subscriptions"),
    help: [
      `Run \`az-axi ${command} show ${kind === "group" ? "--name <group> --subscription <id>" : "--ids <ARM-id>"}${detailSelectors}\` for details`,
      ...(shown.length < items.length ? [`Run \`az-axi ${command} list${selectors} --full\` to show every fetched row`] : []),
      ...(incomplete ? ["More pages exist; paging stopped at 100 pages per subscription. Counts are lower bounds. Narrow the subscription or resource-group scope."] : []),
    ],
  };
}
