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

/**
 * Defender assessments, one row per assessed resource (PLAN.md Section 6.8).
 * The command groups these client-side by recommendation. Paging stops at 10,000
 * rows and the command says so; it does not claim the groups are complete past that.
 *
 * `resourceDetails` is `id` on the REST wire format and `Id` in some Resource Graph
 * documents. Coalesce both. The assessment `id` still carries the resource path
 * when the property is absent, and the command matches `--resource` against it.
 *
 * Source table: `securityresources`.
 * Reference: Defender for Cloud Resource Graph samples
 * (https://learn.microsoft.com/en-us/azure/defender-for-cloud/resource-graph-samples).
 */
export const DEFENDER_ASSESSMENTS = [
  "securityresources",
  '| where type =~ "microsoft.security/assessments"',
  "| extend recommendation = tostring(properties.displayName)",
  "| extend severity = tostring(properties.metadata.severity)",
  "| extend status = tostring(properties.status.code)",
  "| extend resourceId = tostring(coalesce(properties.resourceDetails.Id, properties.resourceDetails.id))",
  "| project recommendation, severity, status, resourceId, subscriptionId, id",
].join("\n");

/**
 * Active Defender alerts by severity, for the dashboard only.
 * ARG stores `Status`/`Severity`; the ARM alerts API uses `status`/`severity`.
 * Reference: "Display all active Microsoft Defender for Cloud alerts" on the
 * Defender for Cloud Resource Graph samples page.
 */
export const DEFENDER_ACTIVE_ALERT_COUNTS = [
  "securityresources",
  '| where type =~ "microsoft.security/locations/alerts"',
  "| extend status = tostring(coalesce(properties.Status, properties.status))",
  '| where status =~ "Active"',
  "| extend severity = tostring(coalesce(properties.Severity, properties.severity))",
  "| summarize alerts = count() by severity",
].join("\n");

export interface DefenderAssessmentsFilters {
  severity?: string;
  status?: string;
  resource?: string;
}

function rejectNewlines(flag: string, value: string, example: string): void {
  if (/[\r\n]/.test(value)) {
    throw new AxiError(`flag --${flag} cannot contain newlines`, "VALIDATION_ERROR", [`Example: ${example}`]);
  }
}

function listClause(field: string, raw: string, flag: string, example: string): string {
  rejectNewlines(flag, raw, example);
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new AxiError(`flag --${flag} needs a non-empty value`, "VALIDATION_ERROR", [`Example: ${example}`]);
  }
  if (parts.length === 1) return `${field} =~ ${kqlString(parts[0]!)}`;
  return `${field} in~ (${parts.map((part) => kqlString(part)).join(", ")})`;
}

function resourceClause(resource: string): string {
  rejectNewlines("resource", resource, "--resource vm1");
  const quoted = kqlString(resource);
  if (resource.startsWith("/")) return `(resourceId contains ${quoted} or id contains ${quoted})`;
  // Case-insensitive path segment, so `vm1` does not match `vm10`.
  const slash = kqlString(`/${resource.toLowerCase()}/`);
  const tail = kqlString(`/${resource.toLowerCase()}`);
  return `(tolower(resourceId) endswith ${tail} or tolower(resourceId) contains ${slash} or tolower(id) contains ${slash})`;
}

/** The exact KQL `defender assessments` sends. With no filters this is `DEFENDER_ASSESSMENTS`. */
export function defenderAssessmentsQuery(filters: DefenderAssessmentsFilters = {}): string {
  const clauses: string[] = [];
  if (filters.severity) clauses.push(listClause("severity", filters.severity, "severity", "--severity High"));
  if (filters.status && filters.status.toLowerCase() !== "all") {
    clauses.push(listClause("status", filters.status, "status", "--status Unhealthy"));
  }
  if (filters.resource) clauses.push(resourceClause(filters.resource));
  if (clauses.length === 0) return DEFENDER_ASSESSMENTS;
  return `${DEFENDER_ASSESSMENTS}\n| where ${clauses.join("\n    and ")}`;
}

/**
 * Defender secure score, one row per subscription (PLAN.md Section 6.8).
 * The list API returns every initiative; `ascScore` is the subscription score
 * the portal shows. `percent` scales the 0-to-1 `score.percentage` ratio to 0-100.
 * The command recomputes it from `current`/`max` when the ratio is absent.
 *
 * Source table: `securityresources`, type `microsoft.security/securescores`.
 * Reference: Secure Scores - List
 * (https://learn.microsoft.com/en-us/rest/api/defenderforcloud/secure-scores/list)
 * and "Secure score per subscription" on the Defender Resource Graph samples page.
 */
export const DEFENDER_SECURE_SCORES = [
  "securityresources",
  '| where type =~ "microsoft.security/securescores"',
  '| where name =~ "ascScore" or tolower(id) endswith "/ascscore"',
  "| extend current = todouble(properties.score.current)",
  "| extend max = todouble(properties.score.max)",
  "| extend percent = round(todouble(properties.score.percentage) * 100, 1)",
  "| project subscriptionId, current, max, percent, id",
].join("\n");

/**
 * Internet exposure checks, one per canned query (PLAN.md Section 6.9).
 * Each projects the same shape (`resource`, `resourceGroup`, `subscriptionId`,
 * `detail`, `id`) so the command formats them identically.
 *
 * Port checks use exact values and numeric ranges. `contains "22"` also matches
 * 220 and 4430, so it is not used. `has_any` matches array elements, not substrings.
 * `defaultSecurityRules` are not custom allows and are not expanded.
 * Validate each query (via `--show-query`) in Resource Graph Explorer before
 * trusting its counts.
 */
export const EXPOSURE_PUBLIC_IPS = [
  "Resources",
  '| where type =~ "microsoft.network/publicipaddresses"',
  "| extend ipConfig = tostring(properties.ipConfiguration.id)",
  "| extend natGateway = tostring(properties.natGateway.id)",
  "| where isnotempty(ipConfig) or isnotempty(natGateway)",
  "| extend ip = tostring(properties.ipAddress)",
  "| extend attachedId = iff(isnotempty(ipConfig), ipConfig, natGateway)",
  '| project resource=name, resourceGroup, subscriptionId, detail=strcat(iff(isnotempty(ip), ip, "no-ip"), " -> ", attachedId), id',
].join("\n");

const EXPOSURE_NSG_HEAD = [
  "Resources",
  '| where type =~ "microsoft.network/networksecuritygroups"',
  "| mv-expand rule = properties.securityRules",
  '| extend access = tostring(rule.properties.access), direction = tostring(rule.properties.direction)',
  '| where access =~ "Allow" and direction =~ "Inbound"',
  "| extend srcPrefix = tostring(rule.properties.sourceAddressPrefix)",
  "| extend srcPrefixes = rule.properties.sourceAddressPrefixes",
  '| where srcPrefix in~ ("*", "Internet", "0.0.0.0/0", "::/0") or srcPrefixes has_any ("*", "Internet", "0.0.0.0/0", "::/0")',
].join("\n");

export const EXPOSURE_MGMT_PORTS = [
  EXPOSURE_NSG_HEAD,
  "| extend portList = iff(array_length(rule.properties.destinationPortRanges) > 0, rule.properties.destinationPortRanges, pack_array(tostring(rule.properties.destinationPortRange)))",
  "| mv-expand portSpec = portList",
  "| extend portText = tostring(portSpec)",
  '| extend rangeStart = toint(iff(portText contains "-", tostring(split(portText, "-")[0]), portText))',
  '| extend rangeEnd = toint(iff(portText contains "-", tostring(split(portText, "-")[1]), portText))',
  '| where portText in~ ("*", "0-65535", "1-65535") or (rangeStart <= 22 and rangeEnd >= 22) or (rangeStart <= 3389 and rangeEnd >= 3389) or (rangeStart <= 5985 and rangeEnd >= 5985) or (rangeStart <= 5986 and rangeEnd >= 5986)',
  '| project resource=name, resourceGroup, subscriptionId, detail=strcat("rule ", tostring(rule.name), " src ", iff(isnotempty(srcPrefix), srcPrefix, tostring(srcPrefixes)), " port ", portText), id',
].join("\n");

export const EXPOSURE_ANY_ANY = [
  EXPOSURE_NSG_HEAD,
  "| extend port = tostring(rule.properties.destinationPortRange)",
  "| extend ports = rule.properties.destinationPortRanges",
  '| where port in~ ("*", "0-65535", "1-65535") or ports has_any ("*", "0-65535", "1-65535")',
  '| project resource=name, resourceGroup, subscriptionId, detail=strcat("rule ", tostring(rule.name), " allows any source to any port"), id',
].join("\n");

export const EXPOSURE_CHECKS = ["public-ips", "mgmt-ports", "any-any"] as const;
export type ExposureCheck = (typeof EXPOSURE_CHECKS)[number];

export function exposureQuery(check: ExposureCheck): string {
  switch (check) {
    case "public-ips":
      return EXPOSURE_PUBLIC_IPS;
    case "mgmt-ports":
      return EXPOSURE_MGMT_PORTS;
    case "any-any":
      return EXPOSURE_ANY_ANY;
  }
}
