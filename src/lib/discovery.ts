import { AxiError } from "axi-sdk-js";
import { RESOURCE_GROUPS, SUBSCRIPTIONS_LIST } from "./apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagText, parseArgs } from "./args.js";
import { request, requestAll } from "./client.js";
import { profileFromArgs, subcommandOf } from "./context.js";
import type { ResolvedProfile } from "./config.js";
import { emptyState, pickFields } from "./format.js";
import { commandFlags } from "./registry.js";
import { SECRET_ACTIONS } from "./policy.js";

interface ArmItem extends Record<string, unknown> {
  id: string;
  name: string;
  type?: string;
  location?: string;
  identity?: { type?: string };
  properties?: { provisioningState?: string };
}
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_SHOW_FIELDS = ["id", "name", "type", "kind", "location", "tags", "sku", "identity", "provisioningState"];

function invalid(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `az-axi group show --help` or `az-axi resource show --help` for selectors"]);
}

function segment(value: string): string {
  if (/[/%?#\\]/.test(value) || value === "." || value === "..") invalid("selector must be a single ARM path segment");
  return encodeURIComponent(value);
}

async function subscriptions(profile: ResolvedProfile): Promise<string[]> {
  const selected = profile.subscriptions;
  if (selected?.length && selected.every((s) => GUID.test(s))) return [...new Set(selected.map((s) => s.toLowerCase()))];
  const { items, nextLink } = await requestAll<{ subscriptionId: string; displayName: string }>(profile,
    { method: "GET", path: "/subscriptions", apiVersion: SUBSCRIPTIONS_LIST }, 100);
  if (nextLink) invalid("subscription discovery is incomplete; select explicit subscription IDs");
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

function compact(item: ArmItem, kind: "group" | "resource"): Record<string, unknown> {
  return kind === "group"
    ? { name: item.name, id: item.id, location: item.location ?? "", state: item.properties?.provisioningState ?? "" }
    : { name: item.name, id: item.id, type: item.type ?? "", location: item.location ?? "" };
}

export async function runDiscovery(kind: "group" | "resource", argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const verb = subcommandOf(args, ["list", "show"], kind);
  assertKnownFlags(args, commandFlags(`${kind} ${verb}`), `${kind} ${verb}`);
  if (args.positionals.length !== 1) invalid("unexpected positional argument");
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (kind === "resource" && verb === "show" && fields?.some((field) => !RESOURCE_SHOW_FIELDS.includes(field))) {
    invalid(`resource show --fields supports only ARM envelope fields: ${RESOURCE_SHOW_FIELDS.join(", ")}; use typed commands or az-axi api for provider details`);
  }
  const limit = flagNumber(args, "limit") ?? 50;
  if (!Number.isInteger(limit) || limit <= 0) invalid("--limit must be a positive integer");
  const name = flagText(args, "name");
  const group = flagText(args, "resource-group");
  const type = flagText(args, "resource-type");
  const ids = flagText(args, "ids");
  const apiVersion = flagText(args, "api-version");
  if (name && kind === "group") segment(name);
  if (group) segment(group);
  let namedResourcePath: string | undefined;
  if (verb === "show") {
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
    return { profile: profile.name, group: pickFields([full ? item : fields ? { ...item, ...compact(item, kind) } : compact(item, kind)], fields)[0] };
  }
  const items: ArmItem[] = [];
  let incomplete = false;
  if (verb === "list") {
    for (const sub of subs) {
      const path = `/subscriptions/${sub}${group ? `/resourceGroups/${segment(group)}` : ""}/${kind === "group" ? "resourcegroups" : "resources"}`;
      const page = await requestAll<ArmItem>(profile, { method: "GET", path, apiVersion: RESOURCE_GROUPS }, 100);
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
  const noun = kind === "group" ? "resource groups" : "resources";
  const selectors = ["profile", "config", "tenant", "subscription", "resource-group", "name", "resource-type"]
    .filter((key) => typeof args.flags[key] === "string")
    .map((key) => ` --${key} ${JSON.stringify(args.flags[key])}`).join("");
  return {
    profile: profile.name,
    total: incomplete ? `${items.length}+` : items.length,
    count: `${shown.length} of ${items.length}${incomplete ? "+" : ""} ${noun}`,
    rows: shown.length ? pickFields(shown.map((item) => full ? item : fields ? { ...item, ...compact(item, kind) } : compact(item, kind)), fields) : emptyState(noun, incomplete ? "in fetched pages; listing is incomplete" : "in selected subscriptions"),
    help: [
      `Run \`az-axi ${kind} show ${kind === "group" ? "--name <group> --subscription <id>" : "--ids <ARM-id>"}\` for details`,
      ...(shown.length < items.length ? [`Run \`az-axi ${kind} list${selectors} --full\` to show every fetched row`] : []),
      ...(incomplete ? ["More pages exist; paging stopped at 100 pages per subscription. Counts are lower bounds. Narrow the subscription or resource-group scope."] : []),
    ],
  };
}
