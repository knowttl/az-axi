import { createHash } from "node:crypto";
import {
  ACTIVITY_LOG,
  ACTION_GROUPS,
  DEFENDER_ALERTS,
  DEFENDER_PRICINGS,
  DEFENDER_SUB_ASSESSMENTS,
  DIAGNOSTIC_SETTINGS,
  METRIC_ALERTS,
  MONITOR_METRICS,
  POLICY,
  POLICY_STATES,
  RESOURCE_GRAPH_RESOURCES,
  ROLE_DEFINITIONS,
  SUBSCRIPTIONS_LIST,
} from "../../dist/lib/apiVersions.js";
import {
  CONTRIBUTOR_ROLE_ID,
  OWNER_ROLE_ID,
  RBAC_ADMIN_ROLE_ID,
  USER_ACCESS_ADMIN_ROLE_ID,
} from "../../dist/lib/roles.js";

// Exact, case-sensitive public vocabulary only. No prefixes or inferred names.
// Routes and versions: src/lib/apiVersions.ts and PLAN.md Section 6.
// Resource Graph columns/types: PLAN.md Sections 6.5-6.9.
// SigninLogs columns: https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/signinlogs
export const PUBLIC_VOCABULARY = Object.freeze([
  "subscriptions", "resourceGroups", "providers", "resources", "locations",
  "alerts", "assessments", "securescores", "roleAssignments", "roleDefinitions",
  "v1", "v1.0", "workspaces", "query", "directoryObjects", "getByIds", "users",
  "api-version", SUBSCRIPTIONS_LIST, RESOURCE_GRAPH_RESOURCES, ACTIVITY_LOG, DEFENDER_ALERTS,
  "Microsoft.Resources", "Microsoft.ResourceGraph", "Microsoft.Authorization",
  "Microsoft.Security", "Microsoft.Compute", "Microsoft.Network", "Microsoft.OperationalInsights",
  "virtualMachines", "publicIPAddresses", "networkSecurityGroups",
  "Active", "New", "Closed", "Dismissed", "Resolved", "High", "Medium", "Low", "Informational",
  "Healthy", "Unhealthy", "NotApplicable", "Succeeded", "Failed", "Canceled", "InProgress",
  "User", "Group", "ServicePrincipal", "Enabled", "Disabled",
  OWNER_ROLE_ID, CONTRIBUTOR_ROLE_ID, RBAC_ADMIN_ROLE_ID, USER_ACCESS_ADMIN_ROLE_ID,
  "id", "name", "type", "location", "tags", "properties", "provisioningState", "resourceGroup", "subscriptionId",
  "https", "management.azure.com", "graph.microsoft.com", "api.loganalytics.io",
  "value", "nextLink", "displayName", "state", "tenantId", "userPrincipalName",
  "data", "count", "totalRecords", "resultTruncated", "$skipToken", "$skiptoken",
  "true", "false", "managementGroups", "options", "$top", "resultFormat", "objectArray",
  "tables", "columns", "rows", "PrimaryResult", "string", "datetime", "long", "int", "real", "bool", "dynamic",
  "error", "code", "message", "details", "innererror",
  "AuthenticationFailed", "ExpiredAuthenticationToken", "InvalidAuthenticationToken",
  "InvalidAuthenticationTokenAudience", "SubscriptionNotFound", "InvalidQuery",
  "InvalidApiVersionParameter", "NoRegisteredProviderFound",
  "principalId", "principalType", "roleName", "roleDefinitionId", "scope", "createdOn",
  "status", "current", "max", "percent", "recommendation", "severity", "resourceId", "resource", "detail",
  "alertDisplayName", "description", "timeGeneratedUtc", "remediationSteps", "compromisedEntity",
  "incidentNumber", "createdTimeUtc", "title",
  "kind", "enabled", "dataTypes",
  POLICY, POLICY_STATES, "Microsoft.PolicyInsights", "policyAssignments", "policyDefinitions", "policySetDefinitions",
  "policyStates", "latest", "queryResults", "odata.count", "odata.nextLink",
  "complianceState", "policyAssignmentId", "policyDefinitionId", "timestamp",
  "policyAssignmentName", "policyAssignmentScope", "policyDefinitionName", "policyDefinitionAction",
  "enforcementMode", "policyType", "policyRule", "if", "then", "effect", "category",
  "policyDefinitionReferenceId", "metadata", "parameters", "mode", "version", "notScopes", "nonComplianceMessages",
  "Default", "DoNotEnforce", "BuiltIn", "Custom", "Static", "Compliant", "NonCompliant", "Exempt", "Conflict", "Unknown",
  "All", "Indexed", "Audit", "Deny", "Append", "Modify", "AuditIfNotExists", "DeployIfNotExists", "Manual",
  "audit", "deny", "disabled", "append", "modify", "auditIfNotExists", "deployIfNotExists", "manual",
  ROLE_DEFINITIONS, DEFENDER_PRICINGS, DEFENDER_SUB_ASSESSMENTS,
  "pricings", "subAssessments", "pricingTier", "subPlan", "enablementTime",
  "freeTrialRemainingTime", "enforce", "resourcesCoverageStatus", "extensions", "isEnabled",
  "additionalExtensionProperties", "deprecated", "replacedBy", "inherited", "inheritedFrom",
  "assignableScopes", "permissions", "actions", "notActions", "dataActions", "notDataActions",
  "BuiltInRole", "CustomRole", "Standard", "Free", "P2", "PartiallyCovered", "FullyCovered", "NotCovered",
  "category", "impact", "remediation", "resourceDetails", "source",
  "cause", "timeGenerated", "vulnId", "additionalData", "assessedResourceType",
  "assessment-name", "assessed-resource-id", "custom-role-only",
  "resourceIdentifiers", "azureResourceId", "entities",
  "eventDataId", "eventTimestamp", "caller", "operationName", "localizedValue", "resourceGroupName", "correlationId",
  "Microsoft.Insights", "eventtypes", "management", "values", "customerId",
  "TimeGenerated", "UserPrincipalName", "IPAddress", "ResultType", "AppDisplayName",
  ACTION_GROUPS, DIAGNOSTIC_SETTINGS, METRIC_ALERTS, MONITOR_METRICS,
  "metricAlerts", "actionGroups", "diagnosticSettings", "metricDefinitions", "metrics",
  "scopes", "criteria", "allOf", "metricName", "metricNamespace", "operator", "threshold",
  "failingPeriods", "numberOfEvaluationPeriods", "minFailingPeriodsToAlert", "alertSensitivity", "componentId",
  "evaluationFrequency", "windowSize", "actionGroupId", "webHookProperties", "groupShortName",
  "emailReceivers", "smsReceivers", "webhookReceivers", "itsmReceivers", "automationRunbookReceivers",
  "voiceReceivers", "logicAppReceivers", "eventHubReceivers", "armRoleReceivers", "azureAppPushReceivers",
  "azureFunctionReceivers", "emailAddress", "countryCode", "phoneNumber", "serviceUri", "workspaceId",
  "connectionId", "region", "automationAccountId", "runbookName", "webhookResourceId", "eventHubNameSpace",
  "eventHubName", "roleId", "functionAppResourceId", "functionName", "useCommonAlertSchema",
  "logs", "categoryGroup", "retentionPolicy", "days", "storageAccountId", "eventHubAuthorizationRuleId",
  "marketplacePartnerId", "unit", "supportedAggregationTypes", "primaryAggregationType",
  "timeseries", "timeStamp", "average", "minimum", "maximum", "timespan", "interval",
  "errorCode", "errorMessage", "metadatavalues", "criterionType", "timeAggregation", "odata.type",
  "Average", "Minimum", "Maximum", "Total", "Count", "Percent", "Bytes", "Seconds", "Milliseconds",
  "BytesPerSecond", "CountPerSecond", "Unspecified", "Success", "InvalidSamplingType",
  "GreaterThan", "LessThan", "GreaterThanOrEqual", "LessThanOrEqual", "Equals", "NotEquals",
  "StaticThresholdCriterion", "DynamicThresholdCriterion",
]);

const PUBLIC = new Set(PUBLIC_VOCABULARY);
const TIMESTAMP_PATTERN = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})";
const TIMESTAMP = new RegExp(`^${TIMESTAMP_PATTERN}$`);
const SEPARATOR_CHARACTERS = "\\s/\\\\?#&=,:;|\"'<>()[\\]{}@";
const SEPARATORS = new RegExp(`^[${SEPARATOR_CHARACTERS}]+$`);
const SEGMENTS = new RegExp(`${TIMESTAMP_PATTERN}|[^${SEPARATOR_CHARACTERS}]+|[${SEPARATOR_CHARACTERS}]+`, "g");

function token(segment) {
  return PUBLIC.has(segment) || (TIMESTAMP.test(segment) && Number.isFinite(Date.parse(segment)))
    ? segment
    : `scrub_${createHash("sha256").update(segment).digest("hex")}`;
}

function scrubString(text) {
  const parts = text.match(SEGMENTS) ?? [];
  // Empty or punctuation-only strings still fall under default deny.
  if (!parts.some((part) => !SEPARATORS.test(part))) return token(text);
  return parts.map((part) => SEPARATORS.test(part) ? part : token(part)).join("");
}

function walk(value) {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [scrubString(key), walk(child)]));
}

/** Scrubs JSON data without mutation. Build first; no benchmark code ships in dist.
 * Throws before returning if any owner's leakCheck string survives, even in public vocabulary.
 */
export function scrub(value, { leakCheck = [] } = {}) {
  const result = walk(value);
  const privateStrings = leakCheck.map((text) => text.toLowerCase());
  const assertClean = (text) => {
    if (privateStrings.some((privateString) => text.toLowerCase().includes(privateString))) {
      throw new Error("Benchmark scrub failed: leakCheck string survived");
    }
  };
  // Check decoded strings as well as serialized JSON so escaping cannot hide a leak.
  const serialized = JSON.stringify(result, (key, child) => {
    assertClean(key);
    if (typeof child === "string") assertClean(child);
    return child;
  });
  assertClean(serialized);
  return result;
}
