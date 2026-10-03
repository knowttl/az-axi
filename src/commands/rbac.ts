import { AxiError } from "axi-sdk-js";
import { RESOURCE_GRAPH_RESOURCES } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagText, parseArgs } from "../lib/args.js";
import { sendRequest } from "../lib/client.js";
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import { countLine, emptyState, pickFields, shortDate, truncate } from "../lib/format.js";
import { isPrivilegedRole, PRIVILEGED_ROLE_IDS } from "../lib/roles.js";
import { resolvePrincipalId, resolvePrincipalNames } from "../lib/principals.js";
import { RBAC_ASSIGNMENTS, rbacAssignmentsQuery, scopeMatches } from "../lib/queries.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { shortenResourceId, subscriptionNameMap } from "../lib/scope.js";
import type { ResolvedProfile } from "../lib/config.js";

export const meta = commandMeta("rbac");

const SUBCOMMANDS = ["list"] as const;
const KNOWN_FLAGS = commandFlags("rbac list");
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const FETCH_TOP = 1000;
const MAX_PAGES = 10;
const CELL_TRUNCATE = 200;
/**
 * Default Resource Graph scope is AtScopeAndBelow, which omits role assignments
 * inherited from a parent management group or the tenant root. A security list
 * has to include those. Requires API 2021-06-01-preview or later; we send 2024-04-01.
 * Reference: https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/query-language
 */
const AUTHORIZATION_SCOPE_FILTER = "AtScopeAboveAndBelow";

interface AssignmentRow {
  principalId?: string;
  principalType?: string;
  roleName?: string;
  roleDefinitionId?: string;
  scope?: string;
  createdOn?: string;
  id?: string;
  subscriptionId?: string;
}

interface ResourceGraphResponse {
  totalRecords?: number;
  count?: number;
  data?: AssignmentRow[];
  $skipToken?: string;
  resultTruncated?: string | boolean;
}

function formatCell(value: unknown, full: boolean): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return full ? value : truncate(value, CELL_TRUNCATE).text;
  return value;
}

function rowKey(row: AssignmentRow): string {
  return row.id || `${row.principalId ?? ""}|${row.roleDefinitionId ?? ""}|${row.scope ?? ""}`;
}

function truncated(value: string | boolean | undefined): boolean {
  return value === true || value === "true";
}

async function fetchAssignments(
  profile: ResolvedProfile,
  query: string,
  subscriptions: string[] | undefined,
  managementGroups: string[] | undefined,
): Promise<{ rows: AssignmentRow[]; totalRecords?: number; incomplete: boolean; quotaRemaining?: string; quotaReset?: string }> {
  const rows: AssignmentRow[] = [];
  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  let skipToken: string | undefined;
  let totalRecords: number | undefined;
  let incomplete = false;
  let quotaRemaining: string | undefined;
  let quotaReset: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (skipToken) {
      if (seenTokens.has(skipToken)) {
        incomplete = true;
        break;
      }
      seenTokens.add(skipToken);
    }
    const response = await sendRequest<ResourceGraphResponse>(profile, {
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
          authorizationScopeFilter: AUTHORIZATION_SCOPE_FILTER,
        },
      },
    });
    const body = response.body ?? {};
    if (totalRecords === undefined && typeof body.totalRecords === "number") totalRecords = body.totalRecords;
    quotaRemaining = response.headers?.["x-ms-user-quota-remaining"];
    quotaReset = response.headers?.["x-ms-user-quota-resets-after"];
    for (const row of body.data ?? []) {
      const key = rowKey(row);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      rows.push(row);
    }
    if (truncated(body.resultTruncated)) incomplete = true;
    const next = body.$skipToken;
    if (!next) {
      skipToken = undefined;
      break;
    }
    skipToken = next;
    if (page === MAX_PAGES - 1) incomplete = true;
  }

  return { rows, totalRecords, incomplete, quotaRemaining, quotaReset };
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  subcommandOf(args, SUBCOMMANDS, "rbac");
  assertKnownFlags(args, KNOWN_FLAGS, "rbac list");
  if (args.positionals.length > 1) {
    throw new AxiError(`unexpected argument \`${args.positionals[1]}\` for \`rbac list\``, "VALIDATION_ERROR", [
      "Run `az-axi rbac list --help` for usage",
    ]);
  }
  if (args.flags["subscription"] === true) {
    throw new AxiError("flag --subscription needs a non-empty value", "VALIDATION_ERROR", [
      "Example: --subscription <id>",
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
  const privilegedOnly = flagBool(args, "privileged");
  const roleFilter = flagText(args, "role");
  const scopeFilter = flagText(args, "scope");
  const principalFlag = flagText(args, "principal");
  const flagMg = flagText(args, "management-group");
  const flagSubs = flagList(args, "subscription");
  const principalId = principalFlag ? await resolvePrincipalId(profile, principalFlag) : undefined;
  const query = rbacAssignmentsQuery({
    principalId,
    role: roleFilter,
    scope: scopeFilter,
    privilegedIds: privilegedOnly ? [...PRIVILEGED_ROLE_IDS] : undefined,
  });

  const showQuery = flagBool(args, "show-query");
  if (showQuery) {
    return {
      profile: profile.name,
      query,
      authorizationScopeFilter: AUTHORIZATION_SCOPE_FILTER,
      ...(flagMg ? { managementGroup: flagMg } : {}),
      ...(flagSubs?.length ? { subscriptions: flagSubs } : {}),
      help: [
        query === RBAC_ASSIGNMENTS
          ? "Run `az-axi rbac list` to execute this query"
          : "This is the exact KQL for the flags you passed, including parent-scope assignments",
      ],
    };
  }

  let subscriptions: string[] | undefined;
  let managementGroups: string[] | undefined;
  const envSubs = (process.env.AZ_AXI_SUBSCRIPTION ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  // $AZ_AXI_SUBSCRIPTION overrides a profile management group. resolveProfile copies
  // the env var onto subscriptions without clearing managementGroup.
  if (flagMg) managementGroups = [flagMg];
  else if (flagSubs?.length) subscriptions = flagSubs;
  else if (envSubs.length > 0) subscriptions = envSubs;
  else if (profile.managementGroup) managementGroups = [profile.managementGroup];
  else if (profile.subscriptions?.length) subscriptions = profile.subscriptions;

  const fetched = await fetchAssignments(profile, query, subscriptions, managementGroups);
  let rows = fetched.rows;

  if (principalId) {
    const wanted = principalId.toLowerCase();
    rows = rows.filter((row) => (row.principalId ?? "").toLowerCase() === wanted);
  }
  if (privilegedOnly) {
    rows = rows.filter((row) => isPrivilegedRole(row.roleDefinitionId));
  }
  if (roleFilter) {
    const wanted = roleFilter.toLowerCase();
    rows = rows.filter((row) => (row.roleName ?? "").toLowerCase().includes(wanted));
  }
  if (scopeFilter) {
    rows = rows.filter((row) => scopeMatches(row.scope ?? "", scopeFilter));
  }

  const scopeHint = [
    principalFlag ? `for principal ${principalFlag}` : "",
    privilegedOnly ? "with privileged roles" : "",
    roleFilter ? `with role matching ${roleFilter}` : "",
    scopeFilter ? `at scope ${scopeFilter}` : "",
    !principalFlag && !privilegedOnly && !roleFilter && !scopeFilter
      ? subscriptions?.length
        ? `for ${subscriptions.length} subscription${subscriptions.length === 1 ? "" : "s"}`
        : managementGroups?.length
          ? `in management group ${managementGroups[0]}`
          : "across accessible subscriptions"
      : "",
  ]
    .filter(Boolean)
    .join(", ");

  const clientDropped = rows.length !== fetched.rows.length;
  const total =
    !clientDropped && fetched.totalRecords !== undefined && fetched.totalRecords >= rows.length
      ? fetched.totalRecords
      : rows.length;

  if (rows.length === 0) {
    return {
      profile: profile.name,
      total: 0,
      count: countLine(0, 0, "assignments"),
      rows: emptyState("role assignments", scopeHint),
      help: [
        "Run `az-axi sub list` to verify the subscriptions in scope",
        "Run `az-axi rbac list --privileged` to focus on standing admin rights",
      ],
    };
  }

  const limited = full ? rows : rows.slice(0, limit);
  const principalIds = [...new Set(limited.map((row) => row.principalId ?? "").filter(Boolean))];
  const { names, resolved } = await resolvePrincipalNames(profile, principalIds);

  const showFullId = full || Boolean(fields?.includes("id"));
  let nameMap: Map<string, string> | undefined;
  if (!full) nameMap = await subscriptionNameMap(profile);

  const byRole: Record<string, number> = {};
  for (const row of rows) {
    const role = row.roleName || "(unknown role)";
    byRole[role] = (byRole[role] ?? 0) + 1;
  }
  const sortedByRole = Object.fromEntries(Object.entries(byRole).sort(([, a], [, b]) => b - a || 0));

  const extended = limited.map((row) => {
    const pid = row.principalId ?? "";
    const principal = names.get(pid.toLowerCase()) ?? pid;
    const scope = row.scope ?? "";
    return {
      principal: formatCell(principal, full),
      type: formatCell(row.principalType ?? "", full),
      role: formatCell(row.roleName ?? "", full),
      roleId: formatCell(row.roleDefinitionId ?? "", full),
      scope: formatCell(full ? scope : shortenResourceId(scope, nameMap), full),
      created: shortDate(row.createdOn),
      id: formatCell(showFullId ? (row.id ?? "") : shortenResourceId(row.id ?? "", nameMap), full),
      subscription: formatCell(row.subscriptionId ?? "", full),
    };
  });

  const picked = fields ? pickFields(extended, fields) : pickFields(extended, ["principal", "type", "role", "scope", "created"]);

  const help: string[] = [];
  if (!resolved) {
    help.push("Principal names could not be resolved; showing raw object IDs");
  }
  if (fetched.quotaRemaining === "0") {
    help.push(
      fetched.quotaReset
        ? `Resource Graph quota exhausted; resets after ${fetched.quotaReset}`
        : "Resource Graph quota exhausted; retry after a few seconds",
    );
  }
  if (fetched.incomplete || (fetched.totalRecords !== undefined && fetched.totalRecords > rows.length && !clientDropped)) {
    help.push("More assignments exist; narrow with --principal, --role, --scope or --privileged");
  } else if (!privilegedOnly && Object.keys(sortedByRole).length > 1) {
    help.push("Run `az-axi rbac list --privileged` to focus on standing admin rights");
  }

  return {
    profile: profile.name,
    total,
    count: countLine(extended.length, total, "assignments"),
    byRole: sortedByRole,
    rows: picked,
    ...(help.length > 0 ? { help } : {}),
  };
}
