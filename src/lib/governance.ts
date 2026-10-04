import { AxiError } from "axi-sdk-js";
import { flagBool, flagList, flagNumber, flagText, type ParsedArgs } from "./args.js";
import { request, requestAll, type RequestOptions } from "./client.js";
import { computeLeafHelp } from "./computeHelp.js";
import type { ResolvedProfile } from "./config.js";
import { subscriptions } from "./discovery.js";
import { countLine, emptyState, pickFields } from "./format.js";
import { governanceLeafHelp } from "./governanceHelp.js";
import { monitorLeafHelp } from "./monitorHelp.js";
import { roleLeafHelp } from "./roleHelp.js";
import { securityReadLeafHelp } from "./securityHelp.js";
import { parseSubscriptionId, shortenResourceId } from "./scope.js";
import { formatFlagValue } from "./shell.js";
import { redact } from "./redact.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;
const STATE_MAX_PAGES = 10;
const LIST_MAX_PAGES = 100;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnyObj = Record<string, unknown>;

export interface GovernanceItem extends AnyObj {
  id: string;
  name: string;
}

export interface FetchedPage {
  items: GovernanceItem[];
  incomplete: boolean;
}

export interface GovernanceCollection {
  /** Words after the top-level command, without the verb (`["assignment"]`, `["set-definition"]`). */
  words: string[];
  /** Top-level command owning this collection (`policy`). */
  top: string;
  noun: string;
  /** ARM collection segment for `--ids` hints (`policyAssignments`, `policyDefinitions`). */
  arm: string;
  apiVersion: string;
  /** Validates `--ids` for this collection before any transport. */
  idTail: RegExp;
  /** Every list request for one subscription (GETs, or POSTs for compliance states). */
  listTargets(subscription: string, group: string | undefined, path: string): RequestOptions[];
  /** Fetches every target; defaults to bounded GET paging. Collections with a
   * different transport or paging contract (policy states) override it. */
  fetchTargets?(profile: ResolvedProfile, targets: RequestOptions[]): Promise<FetchedPage>;
  /** Keeps an item under `--name` (default: exact case-insensitive name match). */
  matchName?(item: GovernanceItem, name: string): boolean;
  /** List ordering (default: by name, ascending). */
  compare?(a: GovernanceItem, b: GovernanceItem): number;
  compact(item: GovernanceItem, full: boolean): AnyObj;
  fields: string[];
  detail(item: GovernanceItem, full: boolean, limit: number): { body: AnyObj };
  aggregate?(items: GovernanceItem[]): AnyObj;
  /** Follow-up hint for the first list row (omitted when there is no detail view).
   * The engine default points at the same collection's show by ARM ID; use an
   * override only when a different command answers the row (assignments point
   * at their definition, states at their assignment). Hints carry identity
   * selectors only, so the suggested command stays valid on every collection. */
  followHint?(first: GovernanceItem, args: ParsedArgs): string | undefined;
  extraListFilter?(item: GovernanceItem, args: ParsedArgs, path: string): boolean;
}

export function governanceInvalid(message: string, path: string): never {
  const help = path.startsWith("role ") ? roleLeafHelp(path)
    : path.startsWith("security ") ? securityReadLeafHelp(path)
    : path.startsWith("monitor ") ? monitorLeafHelp(path)
    : path.startsWith("vm ") || path.startsWith("vmss ") || path.startsWith("disk ") ? computeLeafHelp(path)
    : governanceLeafHelp(path);
  throw new AxiError(message, "VALIDATION_ERROR", [help]);
}

export function governanceSegment(value: string, flag: string, path: string): string {
  if (/[/%?#\\]/.test(value) || value === "." || value === ".." || !value.trim()) {
    governanceInvalid(`--${flag} must name one resource path segment`, path);
  }
  return encodeURIComponent(value.trim());
}

/** Last ARM path segment (`.../policyAssignments/CostManagement` -> `CostManagement`). */
export function tailName(id: string): string {
  const tail = id.split("/").filter(Boolean).pop() ?? "";
  return tail || id;
}

/** Scope shortened for display (`/subscriptions/<id>/resourceGroups/<rg>` -> `<id>/<rg>`). */
export function shortScope(scope: string): string {
  return shortenResourceId(scope);
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function arrOf(value: unknown): AnyObj[] {
  return Array.isArray(value) ? value.filter((entry): entry is AnyObj => !!entry && typeof entry === "object") : [];
}

export function objOf(value: unknown): AnyObj {
  return value && typeof value === "object" ? (value as AnyObj) : {};
}

export function strArr(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

async function defaultFetchTargets(profile: ResolvedProfile, targets: RequestOptions[]): Promise<FetchedPage> {
  const items: GovernanceItem[] = [];
  let incomplete = false;
  for (const target of targets) {
    const page = await requestAll<GovernanceItem>(profile, target, LIST_MAX_PAGES);
    items.push(...page.items);
    incomplete ||= !!page.nextLink;
  }
  const unique = new Map<string, GovernanceItem>();
  for (const item of items) {
    const id = item.id.toLowerCase();
    if (!unique.has(id)) unique.set(id, item);
  }
  return { items: [...unique.values()], incomplete };
}

export function governanceLimit(args: ParsedArgs, path: string): number {
  if (args.flags["limit"] === true || args.flags["limit"] === "") {
    governanceInvalid("flag --limit needs a number", path);
  }
  const limit = flagNumber(args, "limit") ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) governanceInvalid("--limit must be a positive integer", path);
  if (limit > MAX_LIMIT) governanceInvalid(`--limit must be at most ${MAX_LIMIT}`, path);
  return limit;
}

export function selectorSuffix(args: ParsedArgs, keys = ["profile", "config", "tenant", "subscription", "resource-group", "name", "ids", "assignment", "compliance", "assessment-name", "assessed-resource-id", "custom-role-only"]): string {
  return keys
    .filter((key) => key === "custom-role-only" ? flagBool(args, key) : typeof args.flags[key] === "string")
    .map((key) => key === "custom-role-only" ? ` --${key}` : ` ${formatFlagValue(key, args.flags[key] as string)}`).join("");
}

function defaultFollowHint(collection: GovernanceCollection, first: GovernanceItem, args: ParsedArgs): string {
  const selectors = selectorSuffix(args, ["profile", "config", "tenant", "subscription"]);
  const leaf = [collection.top, ...collection.words].join(" ");
  return `Run \`az-axi ${leaf} show ${formatFlagValue("ids", first.id)}${selectors}\` for the first row in detail`;
}

function scopeLabel(subs: string[], group: string | undefined): string {
  const scope = subs.length === 1 ? `in subscription ${subs[0]}` : `in ${subs.length} subscriptions`;
  return group ? `${scope} in resource group ${group}` : scope;
}

export async function runGovernanceList(
  profile: ResolvedProfile,
  args: ParsedArgs,
  collection: GovernanceCollection,
  path: string,
): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !collection.fields.includes(field))) {
    governanceInvalid(`${path} --fields supports only: ${collection.fields.join(", ")}`, path);
  }
  const limit = governanceLimit(args, path);
  const groupFlag = flagText(args, "resource-group");
  const group = groupFlag ? governanceSegment(groupFlag, "resource-group", path) : undefined;
  const name = flagText(args, "name");
  const subs = await subscriptions(profile);
  const suffix = selectorSuffix(args);
  const fetch = collection.fetchTargets ?? defaultFetchTargets;
  const targets = subs.flatMap((sub) => collection.listTargets(sub, group, path));
  const fetched = redact(await fetch(profile, targets));
  const kept = fetched.items.filter((item) => {
    const keepName = !name ||
      (collection.matchName ? collection.matchName(item, name) : item.name.toLowerCase() === name.toLowerCase());
    const keepExtra = !collection.extraListFilter || collection.extraListFilter(item, args, path);
    return keepName && keepExtra;
  });
  kept.sort(collection.compare ?? ((a, b) => a.name.localeCompare(b.name)));

  const total = fetched.incomplete ? `${kept.length}+` : kept.length;
  const context = scopeLabel(subs, groupFlag ?? undefined);
  if (kept.length === 0) {
    return {
      profile: profile.name,
      total,
      count: fetched.incomplete ? `0 of ${total} ${collection.noun}` : countLine(0, 0, collection.noun),
      rows: emptyState(collection.noun, fetched.incomplete ? `${context} in fetched pages; listing is incomplete` : context),
      help: [
        `Run \`az-axi ${path}${suffix} --full\` to show every fetched row`,
        ...(fetched.incomplete ? ["More pages exist; paging stopped early. Counts are lower bounds. Narrow the subscription or resource-group scope."] : []),
      ],
    };
  }

  const displayed = full ? kept : kept.slice(0, limit);
  const shown = displayed.map((item) => collection.compact(item, full));
  const picked = pickFields(shown, fields);
  // Compact tails versus full IDs are precision, not hidden content: only capped
  // rows and genuinely truncated values (the format.ts marker) earn the hint.
  const truncatedValues = !full && /\(truncated, \d+ chars total\)/.test(JSON.stringify(picked));
  const help: string[] = [];
  const first = kept[0]!;
  const follow = collection.followHint ? collection.followHint(first, args) : defaultFollowHint(collection, first, args);
  if (follow) help.push(follow);
  if (shown.length < kept.length || truncatedValues) {
    help.push(`Run \`az-axi ${path}${suffix} --full\` to show every fetched row`);
  }
  if (fetched.incomplete) {
    help.push("More pages exist; paging stopped early. Counts are lower bounds. Narrow the subscription or resource-group scope.");
  }
  return {
    profile: profile.name,
    total,
    count: fetched.incomplete ? `${shown.length} of ${total} ${collection.noun}` : countLine(shown.length, kept.length, collection.noun),
    ...collection.aggregate?.(kept),
    rows: picked,
    help,
  };
}

export async function runGovernanceShow(
  profile: ResolvedProfile,
  args: ParsedArgs,
  collection: GovernanceCollection,
  path: string,
  namedPath: (subscription: string, group: string | undefined, name: string) => string,
): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  const limit = governanceLimit(args, path);
  const showFields = Object.keys(collection.detail({ id: "", name: "" }, true, limit).body);
  if (fields?.some((field) => !showFields.includes(field))) {
    governanceInvalid(`${path} --fields supports only: ${showFields.join(", ")}`, path);
  }
  const name = flagText(args, "name");
  const groupFlag = flagText(args, "resource-group");
  const ids = flagText(args, "ids");
  if (name && ids) governanceInvalid(`${path} takes --name or --ids, not both`, path);
  if (!name && !ids) {
    governanceInvalid(`${path} needs --name or --ids <ARM-id>`, path);
  }
  if (ids && (groupFlag || name)) {
    governanceInvalid("--ids selects the resource itself; name and scope selectors are not accepted with --ids", path);
  }
  const suffix = selectorSuffix(args);

  let getPath: string;
  let subscription: string;
  if (ids) {
    const id = ids.trim();
    if (/[?#%\\]/.test(id)) governanceInvalid("--ids requires an unescaped ARM resource ID without a query or fragment", path);
    if (!collection.idTail.test(id)) {
      governanceInvalid(`--ids must be one ${collection.noun.slice(0, -1)} ARM ID under Microsoft.Authorization/${collection.arm}`, path);
    }
    const subMatch = /^\/subscriptions\/([^/]+)\//i.exec(id);
    if (subMatch && !GUID.test(subMatch[1]!)) governanceInvalid("--ids must carry a subscription GUID", path);
    getPath = id;
    subscription = subMatch?.[1] ?? (await subscriptions(profile))[0]!;
    if (subMatch) {
      const selected = profile.subscriptions?.length ? await subscriptions(profile) : [subscription];
      if (!selected.some((selectedId) => selectedId.toLowerCase() === subscription.toLowerCase())) {
        governanceInvalid("--ids conflicts with selected subscriptions", path);
      }
    }
  } else {
    const selected = await subscriptions(profile);
    if (selected.length !== 1) governanceInvalid(`${path} by name needs exactly one subscription; use --subscription <id>`, path);
    subscription = selected[0]!;
    const group = groupFlag ? governanceSegment(groupFlag, "resource-group", path) : undefined;
    getPath = namedPath(subscription, group, governanceSegment(name!, "name", path));
  }

  const item = redact(await request<GovernanceItem>(profile, { method: "GET", path: getPath, apiVersion: collection.apiVersion }));
  const { body } = collection.detail(item, full, limit);
  const fullBody = collection.detail(item, true, limit).body;
  for (const field of fields ?? []) {
    if (!(field in body)) body[field] = fullBody[field];
  }
  const shortened = !full && JSON.stringify(pickFields([body], fields)) !==
    JSON.stringify(pickFields([fullBody], fields));
  const help: string[] = [];
  if (shortened) {
    help.push(`Run \`az-axi ${path}${suffix} --full\` for every nested row`);
  }
  const picked = pickFields([{ ...body, profile: profile.name, subscription: parseSubscriptionId(item.id ?? "") ?? subscription }], fields)[0]!;
  return {
    profile: profile.name,
    ...picked,
    ...(help.length > 0 ? { help } : {}),
  };
}

/** Paging loop for the policy-states `queryResults` POST contract (`value`,
 * `@odata.count`, `@odata.nextLink` with `$skiptoken`; GET on the operation
 * is unsupported, so an unfollowable next link stops paging with disclosure). */
export async function fetchStatePages(profile: ResolvedProfile, targets: RequestOptions[]): Promise<FetchedPage> {
  const items: GovernanceItem[] = [];
  let incomplete = false;
  for (const target of targets) {
    let skipToken: string | undefined;
    for (let page = 0; page < STATE_MAX_PAGES; page++) {
      const body = await request<{ value?: GovernanceItem[]; "@odata.count"?: unknown; "@odata.nextLink"?: unknown }>(profile, {
        ...target,
        method: "POST",
        query: { ...(target.query ?? {}), ...(skipToken ? { $skiptoken: skipToken } : {}) },
      });
      items.push(...(body?.value ?? []));
      const next = typeof body?.["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : undefined;
      if (!next) break;
      const token = /[?&]\$skiptoken=([^&]*)/i.exec(next)?.[1];
      if (page === STATE_MAX_PAGES - 1 || !token) {
        incomplete = true;
        break;
      }
      skipToken = decodeURIComponent(token);
    }
  }
  return { items, incomplete };
}
