/**
 * Pinned api-versions for every endpoint az-axi calls.
 *
 * Every value below was verified on 2026-10-01 against the stable folders of
 * Azure/azure-rest-api-specs at commit 0447e91e (source 1 of the verification
 * procedure), and against the Microsoft Learn REST reference page (source 2).
 * Only `stable/` folders qualify. Source 3 (`az provider show`, a live check)
 * is owner-run and is not recorded here.
 *
 * Spec paths are relative to `specification/` in that repository.
 * To change a value, re-run the verification procedure for that endpoint and
 * update its doc comment in the same commit.
 */

/**
 * Subscriptions - List (`GET /subscriptions`), also the `doctor` reachability probe.
 *
 * Value: 2022-12-01. Newer stable: none (2022-12-01 is the newest folder).
 * Spec: resources/resource-manager/Microsoft.Resources/subscriptions/stable/2022-12-01/subscriptions.json
 * Docs: https://learn.microsoft.com/en-us/rest/api/resources/subscriptions/list
 * Verified: 2026-10-01
 * Reason: newest stable version; the operation `Subscriptions_List` exists at `/subscriptions`.
 */
export const SUBSCRIPTIONS_LIST = "2022-12-01";

/**
 * Resource groups - Get and Update, owner-only smoke tag round trip.
 * Value: 2021-04-01. Newer stable: 2025-04-01 has the same GET/PATCH shape.
 * Spec: resources/resource-manager/Microsoft.Resources/resources/stable/2021-04-01/resources.json
 * Docs: https://learn.microsoft.com/en-us/rest/api/resources/resource-groups/update?view=rest-resources-2021-04-01
 * Verified: 2026-10-02 against the spec and REST reference.
 * Reason: documented stable GET/PATCH contract; no ETag or If-Match is promised.
 */
export const RESOURCE_GROUPS = "2021-04-01";

/**
 * Storage accounts - Get Properties and Delete, owner-only smoke throwaway target.
 * Value: 2025-06-01. Newer stable: 2026-09-01 in the specification tree.
 * Spec: storage/resource-manager/Microsoft.Storage/stable/2025-06-01/openapi.json
 * Docs: https://learn.microsoft.com/en-us/rest/api/storagerp/storage-accounts/delete?view=rest-storagerp-2025-06-01
 * Verified: 2026-10-02 against the spec and REST reference.
 * Reason: pinned to the verified REST reference's stable GET/DELETE contract;
 * newer versions are not needed for the throwaway check. No credential actions used.
 */
export const STORAGE_ACCOUNTS = "2025-06-01";

/**
 * Resource Graph query (`POST /providers/Microsoft.ResourceGraph/resources`).
 * Also used for `authorizationresources` (rbac list) and `securityresources`
 * (defender assessments, defender score, exposure checks).
 *
 * Value: 2024-04-01. Newer stable: none. The quickstart still shows 2022-10-01.
 * Spec: resourcegraph/resource-manager/Microsoft.ResourceGraph/ResourceGraph/stable/2024-04-01/resourcegraph.json
 * Docs: https://learn.microsoft.com/en-us/azure/governance/resource-graph/first-query-rest-api
 * Verified: 2026-10-01
 * Reason: the request body (`query`, `subscriptions`, `managementGroups`, `options` with
 * `$top`, `$skipToken`, `resultFormat`) and the response (`totalRecords`, `count`,
 * `resultTruncated`, `$skipToken`, `data`, `facets`) are identical to 2022-10-01 (diffed);
 * the only differences are TypeSpec regeneration and an added `Operations_List`.
 * Table names confirmed on the supported-tables page:
 * https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources
 * (`authorizationresources`: microsoft.authorization/roleassignments and roledefinitions;
 * `securityresources`: microsoft.security/assessments and microsoft.security/securescores).
 */
export const RESOURCE_GRAPH_RESOURCES = "2024-04-01";

/**
 * Role Assignments - List For Scope (`GET /{scope}/providers/Microsoft.Authorization/roleAssignments`).
 * Only used as a fallback when Resource Graph is not enough.
 *
 * Value: 2022-04-01. Newer stable: none (2022-04-01 is the newest stable folder).
 * Spec: authorization/resource-manager/Microsoft.Authorization/Authorization/stable/2022-04-01/authorization-RoleAssignmentsCalls.json
 * Docs: https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/list-for-scope
 * Verified: 2026-10-01
 * Reason: newest stable; `RoleAssignments_ListForScope` and `RoleAssignments_ListForSubscription` present.
 */
export const ROLE_ASSIGNMENTS = "2022-04-01";

/**
 * Activity Logs - List
 * (`GET /subscriptions/{id}/providers/Microsoft.Insights/eventtypes/management/values`).
 *
 * Value: 2015-04-01. Newer stable: none. 2015-04-01 is the only stable folder containing
 * `activityLogs_API.json`; later Insights folders only add `activityLogAlerts_API.json`.
 * Spec: monitor/resource-manager/Microsoft.Insights/Insights/stable/2015-04-01/activityLogs_API.json
 * Docs: https://learn.microsoft.com/en-us/rest/api/monitor/activity-logs/list
 * Verified: 2026-10-01
 * Reason: only stable version. `$filter` is required and very restricted: it must contain
 * `eventTimestamp ge/le` and may add one of `resourceGroupName`, `resourceUri`, `resourceProvider`
 * or `correlationId` ("No other syntax is allowed"). The documented grammar has no caller clause,
 * so `--caller` is applied as a client-side filter over retrieved events, and Phase 3 qualifies it
 * live. `$select` is supported (property names such as `eventTimestamp`, `operationName`,
 * `status`, `resourceId`, `resourceGroupName`, `correlationId`); paging is by `nextLink`.
 */
export const ACTIVITY_LOG = "2015-04-01";

/**
 * Defender for Cloud alerts (`GET /subscriptions/{id}/providers/Microsoft.Security/alerts`
 * and `.../locations/{ascLocation}/alerts/{alertName}` for the detail view).
 *
 * Value: 2022-01-01. Newer stable: none. 2022-01-01 is the newest version of the alerts
 * API; the TypeSpec source (`AlertsAPI/main.tsp`) lists no later version.
 * Spec: security/resource-manager/Microsoft.Security/Security/stable/2022-01-01/alerts.json
 * Docs: https://learn.microsoft.com/en-us/rest/api/defenderforcloud/alerts/list
 * and https://learn.microsoft.com/en-us/rest/api/defenderforcloud/alerts/get-subscription-level
 * Verified: 2026-10-01
 * Reason: newest version; `Alerts_List`, `Alerts_GetSubscriptionLevel` present.
 * Status actions verified 2026-10-03 against this spec and REST reference:
 * https://learn.microsoft.com/en-us/rest/api/defenderforcloud/alerts/update-subscription-level-state-to-activate?view=rest-defenderforcloud-2022-01-01
 * Subscription/resource-group scoped POST dismiss, resolve and activate take no body
 * and return 204. The contract documents neither ETag nor If-Match support.
 */
export const DEFENDER_ALERTS = "2022-01-01";

/**
 * Defender for Cloud assessments, ARM fallback (`GET /{scope}/providers/Microsoft.Security/assessments`).
 * The primary source is Resource Graph `securityresources` (see RESOURCE_GRAPH_RESOURCES).
 *
 * Value: 2025-05-04. Newer stable: none; 2021-06-01 is the older alternative.
 * Spec: security/resource-manager/Microsoft.Security/Security/stable/2025-05-04/security-Assessment.json
 * Docs: https://learn.microsoft.com/en-us/rest/api/defenderforcloud/assessments/list
 * Verified: 2026-10-01
 * Reason: newest stable. The list path and the fields az-axi reads (`displayName`, `status.code`,
 * `resourceDetails`, `links`, `metadata`) are unchanged from 2021-06-01; 2025-05-04 only adds `risk`.
 */
export const DEFENDER_ASSESSMENTS = "2025-05-04";

/**
 * Defender for Cloud secure scores, ARM fallback
 * (`GET /subscriptions/{id}/providers/Microsoft.Security/secureScores`).
 * The primary source is Resource Graph `securityresources`, type `microsoft.security/securescores`
 * (type name confirmed on the supported-tables page, see RESOURCE_GRAPH_RESOURCES).
 *
 * Value: 2020-01-01. Newer stable: none (`SecureScoreAPI/main.tsp` lists 2020-01-01 only).
 * Spec: security/resource-manager/Microsoft.Security/Security/stable/2020-01-01/secureScore.json
 * Docs: https://learn.microsoft.com/en-us/rest/api/defenderforcloud/secure-scores/list
 * Verified: 2026-10-01
 * Reason: only version. Score details are `current` (number), `max` (integer) and
 * `percentage` (ratio from 0 to 1).
 */
export const DEFENDER_SECURE_SCORES = "2020-01-01";

/**
 * Management locks, list by scope (`GET /{scope}/providers/Microsoft.Authorization/locks`).
 * Used by dry runs to warn about locks on a delete target.
 *
 * Value: 2020-05-01. Newer stable: none.
 * Spec: resources/resource-manager/Microsoft.Authorization/locks/stable/2020-05-01/locks.json
 * (the locks spec lives under Microsoft.Authorization, not Microsoft.Resources).
 * Docs: https://learn.microsoft.com/en-us/rest/api/resources/management-locks/list-by-scope
 * Verified: 2026-10-01
 * Reason: newest stable; `ManagementLocks_ListByScope`, `...ListAtSubscriptionLevel`,
 * `...ListAtResourceGroupLevel` and `...ListAtResourceLevel` present.
 */
export const MANAGEMENT_LOCKS = "2020-05-01";

/**
 * Deployments - What If, used by deployment dry runs
 * (`POST .../providers/Microsoft.Resources/deployments/{name}/whatIf` at resource group
 * and subscription scope).
 *
 * Value: 2026-06-01. Newer stable: none (2026-06-01 is the newest folder).
 * Spec: resources/resource-manager/Microsoft.Resources/deployments/stable/2026-06-01/deployments.json
 * Docs: https://learn.microsoft.com/en-us/rest/api/resources/deployments/what-if
 * and https://learn.microsoft.com/en-us/rest/api/resources/deployments/what-if-at-subscription-scope
 * Verified: 2026-10-01
 * Reason: newest stable. Paths confirmed (`Deployments_WhatIf` at
 * `/subscriptions/{id}/resourcegroups/{rg}/providers/Microsoft.Resources/deployments/{name}/whatIf`,
 * `Deployments_WhatIfAtSubscriptionScope` at
 * `/subscriptions/{id}/providers/Microsoft.Resources/deployments/{name}/whatIf`). Compared with
 * 2025-04-01 the what-if request and `WhatIfChange` response only gain optional fields
 * (`resourcePredictions`, `resourceType`), and `ChangeType` is unchanged (Create, Delete,
 * Ignore, Deploy, NoChange, Modify, Unsupported). Whether the live service already accepts this
 * version is an owner-run check (`az provider show --namespace Microsoft.Resources`); fall back
 * to 2025-04-01 if it does not.
 */
export const DEPLOYMENTS_WHAT_IF = "2026-06-01";

/**
 * Log Analytics query (`POST https://api.loganalytics.io/v1/workspaces/{workspaceId}/query`,
 * `logs` token). Data plane: the version is the `v1` path segment, not a query parameter.
 *
 * Value: v1. Newer stable: n/a.
 * Spec: not in azure-rest-api-specs `specification/` ARM folders (data plane).
 * Docs: https://learn.microsoft.com/en-us/rest/api/logsquery/query/execute?view=rest-logsquery-v1
 * and https://learn.microsoft.com/en-us/azure/azure-monitor/logs/api/request-format
 * Verified: 2026-10-01
 * Reason: the only version. Body is `{ query, timespan?, workspaces? }` with an ISO 8601
 * `timespan`; `{workspaceId}` is the workspace ID GUID. The response is `{ tables: [{ name,
 * columns: [{ name, type }], rows }] }`.
 * The plan's page (`/rest/api/loganalytics/dataaccess/query/execute`) now returns 404: it moved to
 * the `logsquery` URL above.
 */
export const LOG_ANALYTICS_QUERY = "v1";

/**
 * Microsoft Graph directoryObjects getByIds
 * (`POST https://graph.microsoft.com/v1.0/directoryObjects/getByIds`, `graph` token).
 * Data plane: the version is the `v1.0` path segment.
 *
 * Value: v1.0. Newer stable: n/a.
 * Spec: not in azure-rest-api-specs (Microsoft Graph).
 * Docs: https://learn.microsoft.com/en-us/graph/api/directoryobject-getbyids
 * Verified: 2026-10-01
 * Reason: v1.0 is the stable Graph version. Body is `{ ids: string[], types?: string[] }` with at
 * most 1000 GUIDs; the permission is Directory.Read.All.
 */
export const GRAPH_GET_BY_IDS = "v1.0";
