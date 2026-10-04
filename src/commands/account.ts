import { AxiError } from "axi-sdk-js";
import { SUBSCRIPTIONS_LIST } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, parseArgs } from "../lib/args.js";
import { request, requestAll } from "../lib/client.js";
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import { subscriptions } from "../lib/discovery.js";
import { emptyState, pickFields } from "../lib/format.js";
import { commandMeta } from "../lib/registry.js";
import { formatFlagValue } from "../lib/shell.js";

export const meta = commandMeta("account");
interface Subscription extends Record<string, unknown> {
  subscriptionId: string;
  displayName: string;
}
const FIELDS = ["name", "id", "state", "tenantId", "armId", "authorizationSource", "quotaId", "spendingLimit", "locationPlacementId"];

function metadata(item: Subscription, full: boolean): Record<string, unknown> {
  const compact = { name: item.displayName, id: item.subscriptionId, state: item.state ?? "", tenantId: item.tenantId ?? "" };
  if (!full) return compact;
  return { ...compact, armId: item.id,
    authorizationSource: item.authorizationSource,
    ...pickFields([item.subscriptionPolicies as Record<string, unknown> ?? {}], ["quotaId", "spendingLimit", "locationPlacementId"])[0] };
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const verb = subcommandOf(args, ["list", "show"], "account");
  assertKnownFlags(args, [], `account ${verb}`);
  const invalid = (message: string): never => { throw new AxiError(message, "VALIDATION_ERROR", [`Run \`az-axi account ${verb} --help\` for selectors`]); };
  if (args.positionals.length !== 1) invalid("unexpected positional argument");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !FIELDS.includes(field))) invalid(`account --fields supports only metadata: ${FIELDS.join(", ")}`);
  const full = flagBool(args, "full");
  const limit = flagNumber(args, "limit") ?? 50;
  if (!Number.isInteger(limit) || limit <= 0) invalid("--limit must be a positive integer");
  const profile = profileFromArgs(args);
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) invalid("management-group scope is unsupported for discovery; select subscriptions explicitly");
  if (verb === "show") {
    const ids = await subscriptions(profile);
    if (ids.length !== 1) invalid("account show requires exactly one selected subscription; use --subscription <id>");
    const item = await request<Subscription>(profile, { method: "GET", path: `/subscriptions/${ids[0]}`, apiVersion: SUBSCRIPTIONS_LIST });
    return { profile: profile.name, account: pickFields([metadata(item, full || !!fields)], fields)[0] };
  }
  const page = await requestAll<Subscription>(profile, { method: "GET", path: "/subscriptions", apiVersion: SUBSCRIPTIONS_LIST }, 100);
  const ids = new Set((await subscriptions(profile, page)).map((id) => id.toLowerCase()));
  const items = page.items.filter((item) => ids.has(item.subscriptionId.toLowerCase()));
  const shown = items.slice(0, full ? undefined : limit);
  const suffix = page.nextLink ? "+" : "";
  const identitySelectors = ["profile", "config", "tenant"]
    .filter((key) => typeof args.flags[key] === "string")
    .map((key) => ` ${formatFlagValue(key, args.flags[key] as string)}`).join("");
  const selectors = ["profile", "config", "tenant", "subscription"]
    .filter((key) => typeof args.flags[key] === "string")
    .map((key) => ` ${formatFlagValue(key, args.flags[key] as string)}`).join("");
  return { profile: profile.name, total: page.nextLink ? `${items.length}+` : items.length,
    count: `${shown.length} of ${items.length}${suffix} subscriptions`,
    subscriptions: shown.length ? pickFields(shown.map((item) => metadata(item, full || !!fields)), fields) : emptyState("subscriptions", page.nextLink ? "in fetched pages; listing is incomplete" : "in selected scope"),
    help: [`Run \`az-axi account show --subscription <id>${identitySelectors}\` for live details`,
      ...(shown.length < items.length ? [`Run \`az-axi account list${selectors} --full\` to show every fetched row`] : []),
      ...(page.nextLink ? ["More pages exist; paging stopped at 100 pages. Counts are lower bounds."] : [])] };
}
