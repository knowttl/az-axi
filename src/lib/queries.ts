/**
 * Canned Resource Graph queries as TypeScript constants (PLAN.md best practice 2).
 * Keeping them here means `tsc` ships them in `dist/` with no extra build step,
 * and `--show-query` can print the exact KQL for inspection.
 */

/**
 * Role assignments joined to role definitions in one call (PLAN.md Section 6.6).
 *
 * Source table: `authorizationresources`.
 * Reference: Resource Graph table reference for `authorizationresources`
 * (https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources)
 */
export const RBAC_ASSIGNMENTS = [
  "authorizationresources",
  '| where type == "microsoft.authorization/roleassignments"',
  "| extend principalId = tostring(properties.principalId)",
  "| extend principalType = tostring(properties.principalType)",
  "| extend roleDefinitionId = tostring(properties.roleDefinitionId)",
  "| extend assignmentScope = tostring(properties.scope)",
  "| extend createdOn = tostring(properties.createdOn)",
  "| join kind=leftouter (",
  "    authorizationresources",
  '    | where type == "microsoft.authorization/roledefinitions"',
  "|    extend roleDefinitionId = tostring(id)",
  "|    extend roleName = tostring(properties.roleName)",
  "|    project roleDefinitionId, roleName",
  ") on roleDefinitionId",
  "| project principalId, principalType, roleName, roleDefinitionId, scope=assignmentScope, createdOn, id, subscriptionId",
].join("\n");
