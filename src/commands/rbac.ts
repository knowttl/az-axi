import { AxiError } from "axi-sdk-js";
import { RESOURCE_GRAPH_RESOURCES } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { sendRequest } from "../lib/client.js";
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import { countLine, emptyState, pickFields, shortDate, truncate } from "../lib/format.js";
import { isPrivilegedRole } from "../lib/roles.js";
import { resolvePrincipalId, resolvePrincipalNames } from "../lib/principals.js";
import { RBAC_ASSIGNMENTS } from "../lib/queries.js";
import type { CommandMeta } from "../lib/registry.js";
import { shortenResourceId, subscriptionNameMap } from "../lib/scope.js";

export const meta: CommandMeta = { name: "rbac", effect: "read" };

const SUBCOMMANDS = ["list"] as const;
const KNOWN_FLAGS = ["principal", "role", "scope", "privileged", "show-query"] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const FETCH_TOP = 1000;
const CELL_TRUNCATE = 200;

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
  resultTruncated?: string;
}

function formatCell(value: unknown, full: boolean): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return full ? value : truncate(value, CELL_TRUNCATE).text;
  return value;
}

function scopeMatches(assignmentScope: string, filterScope: string): boolean {
  const a = assignmentScope.trim().toLowerCase();
  const f = filterScope.trim().toLowerCase();
  if (!a || !f) return false;
  return a === f || a.startsWith(f) || f.startsWith(a);
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

  const profile = profileFromArgs(args);
  const showQuery = flagBool(args, "show-query");
  if (showQuery) {
    return {
      profile: profile.name,
      query: RBAC_ASSIGNMENTS,
      help: ['Run `az-axi rbac list` to execute this query'],
    };
  }

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
  const roleFilter = flagString(args, "role")?.toLowerCase();
  const scopeFilter = flagString(args, "scope");
  const principalFlag = flagString(args, "principal");
  const principalId = principalFlag ? await resolvePrincipalId(profile, principalFlag) : undefined;

  const flagSubs = flagList(args, "subscription");
  const flagMg = flagString(args, "management-group");
  let subscriptions: string[] | undefined;
  let managementGroups: string[] | undefined;
  if (flagMg) managementGroups = [flagMg];
  else if (flagSubs?.length) subscriptions = flagSubs;
  else if (profile.managementGroup) managementGroups = [profile.managementGroup];
  else if (profile.subscriptions?.length) subscriptions = profile.subscriptions;

  const response = await sendRequest<ResourceGraphResponse>(profile, {
    method: "POST",
    path: "/providers/Microsoft.ResourceGraph/resources",
    apiVersion: RESOURCE_GRAPH_RESOURCES,
    body: {
      query: RBAC_ASSIGNMENTS,
      ...(subscriptions ? { subscriptions } : {}),
      ...(managementGroups ? { managementGroups } : {}),
      options: { $top: FETCH_TOP, resultFormat: "objectArray" },
    },
  });

  const body = response.body ?? {};
  let rows = body.data ?? [];

  if (principalId) {
    const wanted = principalId.toLowerCase();
    rows = rows.filter((row) => (row.principalId ?? "").toLowerCase() === wanted);
  }
  if (privilegedOnly) {
    rows = rows.filter((row) => isPrivilegedRole(row.roleDefinitionId));
  }
  if (roleFilter) {
    rows = rows.filter((row) => (row.roleName ?? "").toLowerCase().includes(roleFilter));
  }
  if (scopeFilter) {
    rows = rows.filter((row) => scopeMatches(row.scope ?? "", scopeFilter));
  }

  const scopeHint = principalFlag
    ? `for principal ${principalFlag}`
    : privilegedOnly
      ? "with privileged roles"
      : subscriptions?.length
        ? `for ${subscriptions.length} subscription${subscriptions.length === 1 ? "" : "s"}`
        : managementGroups?.length
          ? `in management group ${managementGroups[0]}`
          : "across accessible subscriptions";

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

  const principalIds = [...new Set(rows.map((row) => row.principalId ?? "").filter(Boolean))];
  const { names, resolved } = await resolvePrincipalNames(profile, principalIds);

  let nameMap: Map<string, string> | undefined;
  if (!full) {
    nameMap = await subscriptionNameMap(profile);
  }

  const byRole: Record<string, number> = {};
  for (const row of rows) {
    const role = row.roleName || "(unknown role)";
    byRole[role] = (byRole[role] ?? 0) + 1;
  }
  const sortedByRole = Object.fromEntries(
    Object.entries(byRole).sort(([, a], [, b]) => b - a),
  );

  const extended = rows.map((row) => {
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
      id: formatCell(full ? (row.id ?? "") : shortenResourceId(row.id ?? "", nameMap), full),
      subscription: formatCell(row.subscriptionId ?? "", full),
    };
  });

  const shown = full ? extended : extended.slice(0, limit);
  const picked = fields ? pickFields(shown, fields) : pickFields(shown, ["principal", "type", "role", "scope", "created"]);

  const help: string[] = [];
  if (!resolved) {
    help.push("Principal names could not be resolved (Graph unavailable); showing raw object IDs");
  }
  if (body.$skipToken || body.resultTruncated === "true") {
    help.push("More assignments exist; narrow with --role, --principal or --scope");
  } else if (!privilegedOnly && Object.keys(sortedByRole).length > 1) {
    help.push("Run `az-axi rbac list --privileged` to focus on standing admin rights");
  }

  return {
    profile: profile.name,
    total: rows.length,
    count: countLine(shown.length, rows.length, "assignments"),
    byRole: sortedByRole,
    rows: picked,
    ...(help.length > 0 ? { help } : {}),
  };
}
