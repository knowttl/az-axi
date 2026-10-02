import { AxiError } from "axi-sdk-js";

/**
 * Canned Resource Graph queries as TypeScript constants (PLAN.md best practice 2).
 * Keeping them here means `tsc` ships them in `dist/` with no extra build step,
 * and `--show-query` can print the exact KQL for inspection.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Role assignments joined to role definitions in one call (PLAN.md Section 6.6).
 *
 * Join keys are lower-cased. ARM IDs are case-insensitive, and a case-sensitive
 * KQL join drops role names. This follows the Microsoft Learn RBAC limit queries,
 * which join `tolower(properties.roleDefinitionId)` to `tolower(id)`.
 * Management-group assignments are kept: filtering `id startswith "/subscriptions"`
 * would hide them.
 *
 * Source table: `authorizationresources`.
 * Reference: Resource Graph table reference for `authorizationresources`
 * (https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources)
 * and Troubleshoot Azure RBAC limits
 * (https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshoot-limits).
 */
export const RBAC_ASSIGNMENTS = [
  "authorizationresources",
  '| where type =~ "microsoft.authorization/roleassignments"',
  "| extend principalId = tostring(properties.principalId)",
  "| extend principalType = tostring(properties.principalType)",
  "| extend roleDefinitionId = tolower(tostring(properties.roleDefinitionId))",
  "| extend assignmentScope = tostring(properties.scope)",
  "| extend createdOn = tostring(properties.createdOn)",
  "| join kind=leftouter (",
  "    authorizationresources",
  '    | where type =~ "microsoft.authorization/roledefinitions"',
  "|    extend roleDefinitionId = tolower(id)",
  "|    extend roleName = tostring(properties.roleName)",
  "|    project roleDefinitionId, roleName",
  ") on $left.roleDefinitionId == $right.roleDefinitionId",
  "| project principalId, principalType, roleName, roleDefinitionId, scope=assignmentScope, createdOn, id, subscriptionId",
].join("\n");

export interface RbacQueryFilters {
  principalId?: string;
  role?: string;
  scope?: string;
  privilegedIds?: readonly string[];
}

function kqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function scopeClause(scope: string): string {
  const normalized = scope.trim().replace(/\/+$/, "");
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new AxiError("flag --scope needs an ARM resource ID", "VALIDATION_ERROR", [
      "Example: --scope /subscriptions/<id>",
      "Example: --scope /subscriptions/<id>/resourceGroups/<rg>",
    ]);
  }
  const exact = kqlString(normalized);
  const child = kqlString(`${normalized}/`);
  // Boundary-aware: `rg-demo` must not match `rg-demo-extra`.
  return `(scope =~ ${exact} or scope startswith ${child} or ${exact} startswith strcat(scope, "/"))`;
}

/**
 * The exact KQL `rbac list` sends. With no filters this is `RBAC_ASSIGNMENTS`.
 * Filters are appended so a later page cannot hide a matching assignment that
 * the first 1,000 rows happened to omit.
 */
export function rbacAssignmentsQuery(filters: RbacQueryFilters = {}): string {
  const clauses: string[] = [];
  if (filters.principalId) {
    if (!GUID.test(filters.principalId)) {
      throw new AxiError("principal filter must be an object ID", "VALIDATION_ERROR", [
        "Pass --principal <objectId>",
      ]);
    }
    clauses.push(`principalId =~ ${kqlString(filters.principalId)}`);
  }
  if (filters.privilegedIds && filters.privilegedIds.length > 0) {
    const ids = filters.privilegedIds.map((id) => {
      if (!GUID.test(id)) {
        throw new AxiError("privileged role filter has a non-GUID id", "VALIDATION_ERROR", [
          "This is an az-axi bug: privileged role IDs must be GUIDs",
        ]);
      }
      return kqlString(id.toLowerCase());
    });
    clauses.push(`tolower(tostring(split(roleDefinitionId, "/")[-1])) in (${ids.join(", ")})`);
  }
  if (filters.role) {
    if (/[\r\n]/.test(filters.role)) {
      throw new AxiError("flag --role cannot contain newlines", "VALIDATION_ERROR", [
        "Pass a role name, for example --role Owner",
      ]);
    }
    clauses.push(`roleName contains ${kqlString(filters.role)}`);
  }
  if (filters.scope) clauses.push(scopeClause(filters.scope));
  if (clauses.length === 0) return RBAC_ASSIGNMENTS;
  return `${RBAC_ASSIGNMENTS}\n| where ${clauses.join("\n    and ")}`;
}

/**
 * True when an assignment at `assignmentScope` applies to `filterScope`, or sits
 * under it. A shared prefix is not enough: `rg-demo` must not match `rg-demo-extra`.
 */
export function scopeMatches(assignmentScope: string, filterScope: string): boolean {
  const a = assignmentScope.trim().toLowerCase().replace(/\/+$/, "");
  const f = filterScope.trim().toLowerCase().replace(/\/+$/, "");
  if (!a || !f) return false;
  return a === f || a.startsWith(`${f}/`) || f.startsWith(`${a}/`);
}
