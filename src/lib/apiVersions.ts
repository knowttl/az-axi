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
 * Resource groups - List, Get and Update; generic resource List and provider Get.
 * Discovery GET paths rechecked 2026-10-03 against resources.json and the REST
 * references for resource groups, resources and providers (2021-04-01).
 * https://learn.microsoft.com/en-us/rest/api/resources/resources/list?view=rest-resources-2021-04-01
 * Value: 2021-04-01. Newer stable: 2025-04-01 has the same GET/PATCH shape.
 * Spec: resources/resource-manager/Microsoft.Resources/resources/stable/2021-04-01/resources.json
 * Docs: https://learn.microsoft.com/en-us/rest/api/resources/resource-groups/update?view=rest-resources-2021-04-01
 * Verified: 2026-10-02 against the spec and REST reference.
 * Reason: documented stable GET/PATCH contract; no ETag or If-Match is promised.
 */
export const RESOURCE_GROUPS = "2021-04-01";

/**
 * Resource tags at scope - Get (`GET {scope}/providers/Microsoft.Resources/tags/default`)
 * and selective update (`PATCH {scope}/providers/Microsoft.Resources/tags/default`
 * with `{operation: Merge|Delete, properties: {tags}}`).
 *
 * Value: 2021-04-01. Newer stable: 2025-04-01 documents the same PATCH shape.
 * Spec: resources/resource-manager/Microsoft.Resources/resources/stable/2021-04-01/resources.json
 * (the same stable family as RESOURCE_GROUPS; tags share the Microsoft.Resources contract).
 * Docs: https://learn.microsoft.com/en-us/rest/api/resources/tags/get-at-scope?view=rest-resources-2021-04-01
 * and https://learn.microsoft.com/en-us/rest/api/resources/tags/update-at-scope?view=rest-resources-2021-04-01
 * Verified: 2026-10-04 against the 2021-04-01 and 2025-04-01 REST views (both render
 * the PATCH operation with the Merge/Delete/Replace enum) and the `az tag update`
 * CLI reference (`--operation {Delete, Merge, Replace} --resource-id --tags`).
 * Reason: documented stable GET/PATCH contract; Merge adds or overwrites by name,
 * Delete removes by name, Replace rewrites the whole set (never sent by az-axi).
 * The contract documents neither ETag nor If-Match support.
 */
export const RESOURCE_TAGS = "2021-04-01";

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
 * Microsoft Sentinel incident reads. List and Get by ID use
 * (`GET .../workspaces/{workspaceName}/providers/Microsoft.SecurityInsights/incidents[/{incidentId}]`).
 *
 * Value: 2025-09-01. Newer stable: none (2025-09-01 is the newest stable folder).
 * Spec: securityinsights/resource-manager/Microsoft.SecurityInsights/SecurityInsights/stable/2025-09-01/openapi.json
 * Docs: https://learn.microsoft.com/en-us/rest/api/securityinsights/incidents/list?view=rest-securityinsights-2025-09-01
 * and https://learn.microsoft.com/en-us/rest/api/securityinsights/incidents/get?view=rest-securityinsights-2025-09-01
 * Verified: 2026-10-04 against the spec tree and the REST reference.
 * Reason: newest stable. `Incidents_List` returns `{ value: Incident[] }` with
 * `nextLink` paging and `$filter`/`$orderby`/`$top`/`$skipToken` support;
 * `Incidents_Get` takes the incident GUID name. Incident identity is the GUID
 * `name` plus the sequential `properties.incidentNumber`; status is
 * New/Active/Closed and severity is High/Medium/Low/Informational.
 * Related alerts (`Incidents_ListAlerts`, POST `.../incidents/{incidentId}/alerts`)
 * and entities (`Incidents_ListEntities`, POST `.../incidents/{incidentId}/entities`)
 * are bodyless management-plane reads under this same version: alerts return
 * `{ value: SecurityAlert[] }`, entities return `{ entities: Entity[],
 * metaData: IncidentEntitiesResultsMetadata[] }`, and neither response pages.
 * Verified: 2026-10-04 against the same stable spec tree and the
 * GetAllIncidentAlerts/GetAllIncidentEntities examples.
 * Incident update and comment create verified 2026-10-04 against the REST
 * reference use the same version: `Incidents_CreateOrUpdate` is
 * `PUT .../incidents/{incidentId}` requiring properties severity, status and
 * title with optional classification, classificationReason,
 * classificationComment and owner, plus a top-level etag; `IncidentComments
 * CreateOrUpdate` is `PUT .../incidents/{incidentId}/comments/{incidentCommentId}`
 * with a caller-generated comment ID and `{properties:{message}}`.
 * Docs: https://learn.microsoft.com/en-us/rest/api/securityinsights/incidents/create-or-update?view=rest-securityinsights-2025-09-01
 * and https://learn.microsoft.com/en-us/rest/api/securityinsights/incident-comments/create-or-update?view=rest-securityinsights-2025-09-01
 */
export const SENTINEL_INCIDENTS = "2025-09-01";

/**
 * Microsoft Sentinel alert rules. List and Get by ID use
 * (`GET .../workspaces/{workspaceName}/providers/Microsoft.SecurityInsights/alertRules[/{ruleId}]`).
 *
 * Value: 2025-09-01. Newer stable: none (same newest stable folder as incidents).
 * Spec: securityinsights/resource-manager/Microsoft.SecurityInsights/SecurityInsights/stable/2025-09-01/
 * (the same stable family as SENTINEL_INCIDENTS; AlertRules_List/Get share it).
 * Docs: https://learn.microsoft.com/en-us/rest/api/securityinsights/alert-rules/list?view=rest-securityinsights-2025-09-01
 * and https://learn.microsoft.com/en-us/cli/azure/sentinel/alert-rule?view=azure-cli-latest
 * (`az sentinel alert-rule list|show --resource-group --workspace-name`).
 * Verified: 2026-10-04 against the Learn REST list reference and the CLI
 * reference (second check: the CLI list maps to the same ARM list operation).
 * Reason: `AlertRules_List` returns `{ value: AlertRule[] }` with `nextLink`
 * paging; `AlertRules_Get` takes the rule ID name. The rule `kind`
 * (Scheduled, NRT, MicrosoftSecurityIncidentCreation, Fusion, ...) selects the
 * properties shape; only metadata is read, never a rule mutation.
 */
export const SENTINEL_ALERT_RULES = "2025-09-01";

/**
 * Microsoft Sentinel data connectors. List and Get by ID use
 * (`GET .../workspaces/{workspaceName}/providers/Microsoft.SecurityInsights/dataConnectors[/{connectorId}]`).
 *
 * Value: 2025-09-01. Newer stable: none (same newest stable folder as incidents).
 * Spec: securityinsights/resource-manager/Microsoft.SecurityInsights/SecurityInsights/stable/2025-09-01/
 * (the same stable family as SENTINEL_INCIDENTS; DataConnectors_List/Get share it).
 * Docs: https://learn.microsoft.com/en-us/rest/api/securityinsights/data-connectors/list?view=rest-securityinsights-2025-09-01
 * and https://learn.microsoft.com/en-us/cli/azure/sentinel/data-connector?view=azure-cli-latest
 * (`az sentinel data-connector list|show --resource-group --workspace-name`).
 * Verified: 2026-10-04 against the Learn REST list reference and the CLI
 * reference (second check: the CLI list maps to the same ARM list operation).
 * Reason: `DataConnectors_List` returns `{ value: DataConnector[] }` with
 * `nextLink` paging; `DataConnectors_Get` takes the connector ID name. Only
 * connector metadata is projected; credential-bearing fields are omitted by
 * construction and credential-returning actions are never called.
 */
export const SENTINEL_DATA_CONNECTORS = "2025-09-01";

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
 * Policy assignments, definitions and set definitions, list and get
 * (`GET /{scope}/providers/Microsoft.Authorization/policyAssignments[/{name}]`,
 * `GET {subscription|tenant}/providers/Microsoft.Authorization/policyDefinitions[/{name}]`,
 * `GET {subscription|tenant}/providers/Microsoft.Authorization/policySetDefinitions[/{name}]`).
 *
 * Value: 2021-06-01. Newer stable: several (up to 2026-07-01), but 2024-04-01
 * splits the family (assignments plus types only) while 2021-06-01 keeps all
 * three list/get operations in one stable contract.
 * Spec: resources/resource-manager/Microsoft.Authorization/policy/stable/2021-06-01/
 * (policyAssignments.json, policyDefinitions.json, policySetDefinitions.json).
 * Docs: https://learn.microsoft.com/en-us/rest/api/policy-authorization/policy-assignments/list?view=rest-policy-authorization-2021-06-01
 * and https://learn.microsoft.com/en-us/rest/api/policy-authorization/policy-definitions/list?view=rest-policy-authorization-2021-06-01
 * Verified: 2026-10-04 against the spec tree (second check: the Learn REST
 * assignment reference documents the same list operation with the `{ value,
 * nextLink }` shape and the policyDefinitionId/scope/enforcementMode record).
 * Reason: long-standing stable version covering assignments, definitions and
 * initiatives with `{ value: T[] }` plus `nextLink` list responses. No native
 * policy mutation commands are available; generic api writes to assignments
 * are destructive under policy and require the existing destructive confirmation.
 */
export const POLICY = "2021-06-01";

/**
 * Policy compliance states, latest query results at subscription and resource
 * group scope (`POST .../providers/Microsoft.PolicyInsights/policyStates/latest/queryResults`).
 *
 * Value: 2024-10-01. Newer stable: none (2024-10-01 is the newest stable folder).
 * Spec: policyinsights/resource-manager/Microsoft.PolicyInsights/PolicyInsights/stable/2024-10-01/
 * Docs: https://learn.microsoft.com/en-us/rest/api/policyinsights/policy-states/list-query-results-for-subscription?view=rest-policyinsights-2024-10-01
 * Verified: 2026-10-04 against the spec tree (second check: the Learn REST
 * reference documents the bodyless POST, the `$top`/`$filter`/`$skiptoken`
 * query parameters, and the `{ value: PolicyState[], @odata.count,
 * @odata.nextLink }` response with the complianceState, policyAssignmentId,
 * policyDefinitionId and resourceId record shape).
 * Reason: newest stable. The query is a bodyless management-plane read POST
 * with OData query parameters only, classified as a reviewed read exactly like
 * the Sentinel incident related-alert/entity POSTs. Summaries, scans and
 * remediations are separate operations and are never constructed.
 */
export const POLICY_STATES = "2024-10-01";

/**
 * Deny assignments, list and get (`GET /{scope}/providers/Microsoft.Authorization/
 * denyAssignments[/{denyAssignmentId}]`). There is no dedicated Azure CLI group
 * for deny assignments; the spelling follows the ARM resource type.
 *
 * Value: 2022-04-01. Newer stable: none (2022-04-01 is the newest stable folder,
 * the same family as ROLE_ASSIGNMENTS).
 * Spec: authorization/resource-manager/Microsoft.Authorization/Authorization/stable/2022-04-01/
 * (authorization-DenyAssignmentCalls.json).
 * Docs: https://learn.microsoft.com/en-us/rest/api/authorization/deny-assignments/get?view=rest-authorization-2022-04-01
 * Verified: 2026-10-04 against the spec tree (second check: the Learn REST
 * get reference documents the same path, version and DenyAssignment shape
 * with principals, permissions and scope).
 * Reason: newest stable; `DenyAssignments_List` and `DenyAssignments_Get`
 * present with `{ value: T[] }` plus `nextLink` list responses. No native
 * deny-assignment mutation commands are available; generic api writes are
 * destructive under policy and require the existing destructive confirmation.
 */
export const DENY_ASSIGNMENTS = "2022-04-01";

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
 * Workspace List, ListByResourceGroup and Get, ARM metadata only.
 * Value: 2025-07-01, stable REST contract verified 2026-10-03.
 * Docs: https://learn.microsoft.com/en-us/rest/api/loganalytics/workspaces/list?view=rest-loganalytics-2025-07-01
 * and https://learn.microsoft.com/en-us/rest/api/loganalytics/workspaces/get?view=rest-loganalytics-2025-07-01
 * SharedKeys and child resources/actions are excluded.
 */
export const LOG_ANALYTICS_WORKSPACES = "2025-07-01";

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

/**
 * Key Vault data-plane property listings (`GET https://{vault}.vault.azure.net/secrets`,
 * `/keys`, `/certificates`, `vault` token for https://vault.azure.net/).
 *
 * Value: 7.4. Newer stable: the Learn REST view `rest-keyvault-secrets-7.4` is the
 * current stable data-plane reference; newer dated versions were not pinned.
 * Spec: not in azure-rest-api-specs `specification/` ARM folders (data plane).
 * Docs: https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secrets?view=rest-keyvault-secrets-7.4
 * and https://learn.microsoft.com/en-us/rest/api/keyvault/keys/get-keys?view=rest-keyvault-keys-7.4
 * and https://learn.microsoft.com/en-us/rest/api/keyvault/certificates/get-certificates?view=rest-keyvault-certificates-7.4
 * Verified: 2026-10-04 against the pinned Azure CLI source (dev at da4c0548:
 * `keyvault secret list` maps to `list_properties_of_secrets` while `show` maps to
 * value-returning `get_secret`) and the stable Learn REST views, which document that
 * list operations return property items without secret, key or certificate values.
 * Reason: long-standing stable data-plane version; list responses carry only
 * `{ id/kid, attributes: { enabled, created, updated, exp, nbf }, tags, contentType/x5t,
 * managed }` plus an opaque `nextLink`. Single-object GETs (`/secrets/{name}`,
 * `/keys/{name}`, `/certificates/{name}`) return values or key material and are never
 * constructed by az-axi.
 */
export const KEYVAULT_DATA_PLANE = "7.4";

/**
 * Microsoft.Network management-plane reads for NSGs, NICs, VNets, public IP
 * addresses and private endpoints (`GET .../providers/Microsoft.Network/
 * {networkSecurityGroups|networkInterfaces|virtualNetworks|publicIPAddresses|
 * privateEndpoints}[/{name}]`).
 *
 * Value: 2024-05-01. Newer stable: none pinned; fall back to 2023-09-01 if the
 * live service rejects this version.
 * Spec: network/resource-manager/Microsoft.Network/stable/2024-05-01/
 * (networkSecurityGroup.json, networkInterface.json, virtualNetwork.json,
 * publicIpAddress.json, privateEndpoint.json).
 * Docs: https://learn.microsoft.com/en-us/rest/api/virtualnetwork/network-security-groups/list?view=rest-virtualnetwork-2024-05-01
 * and https://learn.microsoft.com/en-us/rest/api/virtualnetwork/virtual-networks/list?view=rest-virtualnetwork-2024-05-01
 * Verified: 2026-10-04 from the stable REST reference family (second check:
 * the `az network nsg|nic|vnet|public-ip|private-endpoint list|show` leaves map
 * to these same ARM list/get operations). Owner live check:
 * `az provider show --namespace Microsoft.Network` must list 2024-05-01.
 * Reason: stable management-plane version covering all five collections with
 * `{ value: T[] }` plus `nextLink` list responses. NSG rules and VNet subnets
 * arrive nested in the same GET, so no extra calls exist. Effective security
 * rules, effective routes and Network Watcher diagnostics are separate
 * operations and are never constructed by the network reads.
 */
export const NETWORK = "2024-05-01";

/**
 * Microsoft.Network public DNS reads: zones (`GET .../providers/
 * Microsoft.Network/dnszones[/{zoneName}]`) and record sets
 * (`GET .../dnszones/{zoneName}/recordsets`,
 * `GET .../dnszones/{zoneName}/{recordType}/{relativeRecordSetName}`).
 *
 * Value: 2018-05-01. Newer stable: none (2018-05-01 is the newest stable
 * folder for dnszones and record sets).
 * Spec: network/resource-manager/Microsoft.Network/stable/2018-05-01/
 * (dnszone.json, recordset.json).
 * Docs: https://learn.microsoft.com/en-us/rest/api/dns/dns-zones/list-by-resource-group?view=rest-dns-2018-05-01
 * and https://learn.microsoft.com/en-us/rest/api/dns/record-sets/list-by-dns-zone?view=rest-dns-2018-05-01
 * and https://learn.microsoft.com/en-us/rest/api/dns/record-sets/get?view=rest-dns-2018-05-01
 * Verified: 2026-10-04 from the stable REST reference family (second check:
 * the `az network dns zone list|show` leaves map to the zone list/get, and
 * Terraform's `azurerm_dns_{a,aaaa,cname,mx,ns,ptr,soa,srv,txt,caa}_record`
 * resource IDs corroborate the `/{recordType}/{relativeName}` get shape).
 * Owner live check: `az network dns zone list -g <group>` and
 * `az network dns record-set list -g <group> -z <zone>` against a disposable
 * test zone must return the same record sets.
 * Reason: long-standing stable DNS version. Zone responses carry
 * `numberOfRecordSets` and `nameServers`; record-set responses carry only
 * routing records (no credentials). DNSSEC signing keys, private DNS zones
 * and zonefile downloads are separate operations and are never constructed.
 */
export const NETWORK_DNS = "2018-05-01";
