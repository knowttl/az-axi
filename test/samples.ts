// Shared synthetic Azure payloads for command tests and token budgets
// (PLAN.md Sections 7.3, 8 and 14.3).
//
// Every payload is hand-built from the shape of Microsoft's published
// specification examples (see each `source:` comment), with every identifier
// replaced by a synthetic value: GUIDs use 00000000-0000-0000-0000-0000000000NN,
// mailboxes use contoso.com, resource names are generic. Never paste a live
// response here, even scrubbed.

/** Synthetic GUID: 00000000-0000-0000-0000-0000000000NN. */
export const SYN = (n: number): string =>
  `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;

export const TENANT = SYN(1);
export const SUB_A = SYN(20);

// source: security/resource-manager/Microsoft.Security/Security/stable/2022-01-01/examples/Alerts/GetAlertSubscriptionLocation_example.json
export const defenderAlertUpdateState = { properties: { status: "Active" } };
// source: learn.microsoft.com/rest/api/resources/tags/get-at-scope (2021-04-01 example, synthetic).
export const tagUpdateState = { id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Resources/tags/default`,
  name: "default", type: "Microsoft.Resources/tags", properties: { tags: { env: "dev" } } };
export const SUB_B = SYN(21);
export const SUB_C = SYN(22);

// source: learn.microsoft.com/rest/api/storageservices/list-containers2 and list-blobs (synthetic).
export const storageContainers = '<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="https://stexample.blob.core.windows.net"><Containers><Container><Name>example</Name><Properties><Last-Modified>Wed, 30 Sep 2026 12:00:00 GMT</Last-Modified><Etag>&quot;etag-1&quot;</Etag><PublicAccess>blob</PublicAccess></Properties><Metadata><password>never-output-this-value</password></Metadata></Container></Containers><NextMarker /></EnumerationResults>';
export const storageBlobs = '<EnumerationResults><Blobs><Blob><Name>folder/a&amp;b.txt</Name><Properties><Last-Modified>Wed, 30 Sep 2026 12:00:00 GMT</Last-Modified><Etag>&quot;etag-2&quot;</Etag><Content-Length>42</Content-Length><BlobType>BlockBlob</BlobType></Properties><Metadata><value>never-output-this-value</value></Metadata><Tags><TagSet><Tag><Key>secret</Key><Value>never-output-this-value</Value></Tag></TagSet></Tags></Blob></Blobs><NextMarker>next&amp;page</NextMarker></EnumerationResults>';
// source: learn.microsoft.com/rest/api/storageservices/get-blob-properties and get-container-properties.
export const storageProperties = { "last-modified": "Wed, 30 Sep 2026 12:00:00 GMT", etag: '"etag-1"', "content-length": "42", "x-ms-blob-type": "BlockBlob", "x-ms-blob-public-access": "blob", "x-ms-meta-value": "never-output-this-value" };
export const storageMetadataRows = {
  container: { name: "example", lastModified: storageProperties["last-modified"], etag: storageProperties.etag, publicAccess: "blob" },
  blob: { name: "example", lastModified: storageProperties["last-modified"], etag: storageProperties.etag, size: "42", blobType: "BlockBlob" },
};
// source: learn.microsoft.com/rest/api/keyvault/secrets/get-secrets, keys/get-keys and
// certificates/get-certificates (synthetic). Epoch attributes are 2026-10-04T00:00:00Z (created),
// +30d (expiresOn) and -1d (notBefore). Unexpected members must never reach output rows.
export const keyvaultSecrets = JSON.stringify({ value: [{
  id: "https://kvexample.vault.azure.net/secrets/example-secret", contentType: "text/plain",
  attributes: { enabled: true, created: 1791072000, updated: 1791072000, exp: 1793664000, nbf: 1790985600 },
  tags: { owner: "never-output-this-value" }, managed: false, value: "never-output-this-value",
}] });
export const keyvaultKeys = JSON.stringify({ value: [{
  kid: "https://kvexample.vault.azure.net/keys/example-key",
  attributes: { enabled: true, created: 1791072000, updated: 1791072000, exp: 1793664000 },
  tags: { owner: "never-output-this-value" }, managed: true, key: { kty: "never-output-this-value" },
}] });
export const keyvaultCertificates = JSON.stringify({ value: [{
  id: "https://kvexample.vault.azure.net/certificates/example-cert", x5t: "dGVzdA",
  attributes: { enabled: false, created: 1791072000, updated: 1791072000 },
  tags: { owner: "never-output-this-value" }, managed: false, cer: "never-output-this-value",
}] });
export const keyvaultMetadataRows = {
  secret: { name: "example-secret", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z", notBefore: "2026-10-03T00:00:00.000Z", created: "2026-10-04T00:00:00.000Z", updated: "2026-10-04T00:00:00.000Z", contentType: "text/plain", managed: false },
  key: { name: "example-key", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z", notBefore: "", created: "2026-10-04T00:00:00.000Z", updated: "2026-10-04T00:00:00.000Z", managed: true },
  certificate: { name: "example-cert", enabled: false, expiresOn: "", notBefore: "", created: "2026-10-04T00:00:00.000Z", updated: "2026-10-04T00:00:00.000Z", thumbprint: "dGVzdA", managed: false },
};
// source: learn.microsoft.com/rest/api/registry-dataplane/container-registry get-repositories, get-tags and get-manifest (synthetic).
export const acrCatalog = { repositories: ["hello-world", "nanoserver"] };
export const acrTags = { imageName: "hello-world", registry: "myregistry.azurecr.io", tags: [
  { name: "latest", digest: "sha256:110d2b6c84592561338aa040b1b14b7ab81c2f9edbd564c2285dd7d70d777086", createdTime: "2026-09-06T06:17:21.0856539Z", lastUpdateTime: "2026-09-06T06:17:21.0856539Z" },
]};
export const acrManifest = { mediaType: "application/vnd.docker.distribution.manifest.v2+json", schemaVersion: 2,
  config: { digest: "sha256:691fbc2d44fff48357bba69ab0505b9bf12b2b250a925a84a0b8e8e7eed390b2", mediaType: "application/vnd.docker.container.image.v1+json", size: 5824 },
  layers: [{ digest: "sha256:a073c86ecf9e0f29180e80e9638d4c741970695851ea48247276c32c57e40282", mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", size: 2014658 }],
  signatures: [{ signature: "never-output-this-value" }], history: [{ v1Compatibility: "never-output-this-value" }] };
export const acrDigest = "sha256:110d2b6c84592561338aa040b1b14b7ab81c2f9edbd564c2285dd7d70d777086";
export const acrMetadataRows = {
  repository: { name: "hello-world" },
  tag: { name: "latest", digest: acrDigest, createdTime: "2026-09-06T06:17:21.0856539Z", lastUpdateTime: "2026-09-06T06:17:21.0856539Z" },
  manifest: { digest: acrDigest, mediaType: acrManifest.mediaType, schemaVersion: 2,
    config: acrManifest.config, layers: acrManifest.layers },
};
export const WORKSPACE = SYN(10);

// source: azure-mgmt-resource 23.3.0 ResourceGroup (catalogue-pinned GET)
export const azResourceGroup = {
  id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo`, name: "rg-demo", location: "westeurope",
  properties: { provisioningState: "Succeeded" }, tags: { owner: "ops" },
};
// source: resources/resource-manager/Microsoft.Resources/resources/stable/2021-04-01/examples/ListResourceGroups.json
export const discoveryGroup = {
  id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo`, name: "rg-demo", location: "westus",
  properties: { provisioningState: "Succeeded" }, tags: { env: "test" },
};
// source: resources/resource-manager/Microsoft.Resources/resources/stable/2021-04-01/examples/ListResources.json
export const discoveryResource = {
  id: `${discoveryGroup.id}/providers/Microsoft.Compute/virtualMachines/vm1`,
  name: "vm1", type: "Microsoft.Compute/virtualMachines", location: "westus", tags: { env: "test" },
  properties: { provisioningState: "Succeeded" },
};

// source: WorkspacesSubscriptionListForWorkSpace.json and WorkspacesGet.json, REST Log Analytics@2025-07-01 (synthetic).
export const discoveryWorkspace = {
  id: `${discoveryGroup.id}/providers/Microsoft.OperationalInsights/workspaces/logs-demo`,
  name: "logs-demo", type: "Microsoft.OperationalInsights/workspaces", location: "westus", tags: { env: "test" },
  properties: { customerId: WORKSPACE, provisioningState: "Succeeded", retentionInDays: 30,
    sku: { name: "PerGB2018" }, publicNetworkAccessForIngestion: "Enabled", publicNetworkAccessForQuery: "Enabled" },
};

// source: resources/resource-manager/Microsoft.Resources/subscriptions/stable/2022-12-01/examples/GetSubscription.json
export const discoveryAccount = {
  id: `/subscriptions/${SUB_A}`, subscriptionId: SUB_A, displayName: "Sandbox", state: "Enabled", tenantId: TENANT,
  authorizationSource: "RoleBased", subscriptionPolicies: { quotaId: "PayAsYouGo", spendingLimit: "Off", locationPlacementId: "Public" },
};

export const discoveryWorkflow = {
  id: `${discoveryGroup.id}/providers/Microsoft.Logic/workflows/http-demo`,
  name: "http-demo", type: "Microsoft.Logic/workflows", location: "westus",
  properties: { definition: { actions: { http: { type: "Http", inputs: {
    headers: {
      authorization: "opaque-header-value", "x-api-key": "opaque-header-value",
      "api-key": "opaque-header-value", apikey: "opaque-header-value",
      "ocp-apim-subscription-key": "opaque-header-value", "x-functions-key": "opaque-header-value",
      "custom-key": "opaque-header-value", "custom-token": "opaque-header-value",
      "custom-secret": "opaque-header-value", password: "opaque-header-value",
      connectionstring: "opaque-header-value", X_API_KEY: "opaque-header-value",
      "Connection_String": "opaque-header-value", Accept: "application/json",
    },
    authentication: { type: "Raw", value: "Basic dXNlcjpwYXNz" },
  } }, certificate: { type: "Http", inputs: {
    authentication: { type: "ClientCertificate", pfx: "opaque-pfx-value" },
  } } } } },
};

// source: resources/resource-manager/Microsoft.Resources/subscriptions/stable/2022-12-01/examples/GetSubscriptions.json
export const subscriptionList = [
  { id: `/subscriptions/${SUB_A}`, subscriptionId: SUB_A, displayName: "Sandbox", state: "Enabled" },
  { id: `/subscriptions/${SUB_B}`, subscriptionId: SUB_B, displayName: "Lab", state: "Enabled" },
  { id: `/subscriptions/${SUB_C}`, subscriptionId: SUB_C, displayName: "Archive", state: "Disabled" },
];

// source: resourcegraph/resource-manager/Microsoft.ResourceGraph/ResourceGraph/stable/2024-04-01/examples/ResourcesComplexQuery.json
export const resourceGraphPage = {
  totalRecords: 3,
  count: 3,
  data: [
    {
      name: "vm1",
      type: "microsoft.compute/virtualmachines",
      id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm1`,
      resourceGroup: "rg-demo",
      location: "westeurope",
    },
    {
      name: "st1",
      type: "microsoft.storage/storageaccounts",
      id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Storage/storageAccounts/st1`,
      resourceGroup: "rg-demo",
      location: "westeurope",
    },
    {
      name: "nsg1",
      type: "microsoft.network/networksecuritygroups",
      id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/networkSecurityGroups/nsg1`,
      resourceGroup: "rg-demo",
      properties: { subnets: [{ id: "subnet-1" }, { id: "subnet-2" }], rules: 4 },
    },
  ],
};

// source: authorization table reference for authorizationresources (identifiers replaced)
export const rbacAssignments = [
  {
    principalId: SYN(40),
    principalType: "User",
    roleName: "Owner",
    roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${SYN(60)}`,
    scope: `/subscriptions/${SUB_A}`,
    createdOn: "2026-09-20T10:00:00.000Z",
    id: `/subscriptions/${SUB_A}/providers/Microsoft.Authorization/roleAssignments/${SYN(50)}`,
    subscriptionId: SUB_A,
  },
  {
    principalId: SYN(41),
    principalType: "ServicePrincipal",
    roleName: "Reader",
    roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${SYN(61)}`,
    scope: `/subscriptions/${SUB_A}/resourceGroups/rg-demo`,
    createdOn: "2026-09-19T10:00:00.000Z",
    id: `/subscriptions/${SUB_A}/providers/Microsoft.Authorization/roleAssignments/${SYN(51)}`,
    subscriptionId: SUB_A,
  },
  {
    principalId: SYN(40),
    principalType: "User",
    roleName: "Contributor",
    roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${SYN(62)}`,
    scope: `/subscriptions/${SUB_B}`,
    createdOn: "2026-09-18T10:00:00.000Z",
    id: `/subscriptions/${SUB_B}/providers/Microsoft.Authorization/roleAssignments/${SYN(52)}`,
    subscriptionId: SUB_B,
  },
];

// source: Microsoft Graph directoryObject getByIds response shape (identifiers replaced)
export const graphNames = {
  value: [
    { id: SYN(40), displayName: "Analyst" },
    { id: SYN(41), displayName: "Deployer" },
  ],
};

// source: monitor/resource-manager/Microsoft.Insights/Insights/stable/2015-04-01/examples/activityLogs_API.json
export const activityEvents = [
  {
    eventTimestamp: "2026-09-30T12:00:00.000Z",
    caller: "analyst@contoso.com",
    operationName: { value: "Microsoft.Compute/virtualMachines/write", localizedValue: "Create or Update Virtual Machine" },
    status: { value: "Succeeded", localizedValue: "Succeeded" },
    resourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm1`,
    resourceGroupName: "rg-demo",
    correlationId: SYN(70),
  },
  {
    eventTimestamp: "2026-09-30T11:42:00.000Z",
    caller: "deployer@contoso.com",
    operationName: { value: "Microsoft.Storage/storageAccounts/listKeys/action", localizedValue: "List Storage Account Keys" },
    status: { value: "Failed", localizedValue: "Failed" },
    resourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Storage/storageAccounts/st1`,
    resourceGroupName: "rg-demo",
    correlationId: SYN(71),
  },
];

// source: security/resource-manager/Microsoft.Security/Security/stable/2022-01-01/examples/alerts.json
const defenderAlert = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: `/subscriptions/${SUB_A}/providers/Microsoft.Security/locations/westeurope/alerts/${name}`,
  name,
  properties: {
    alertDisplayName: "Suspicious process execution",
    description: "A process behaved unusually on the virtual machine.",
    severity: "High",
    status: "Active",
    timeGeneratedUtc: "2026-09-30T12:00:00.000Z",
    remediationSteps: ["Isolate the machine", "Reset credentials"],
    resourceIdentifiers: [
      {
        azureResourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm1`,
      },
    ],
    entities: [{ type: "host", hostname: "vm1" }],
  },
  ...overrides,
});

export const defenderAlerts = [
  defenderAlert("alert-1"),
  defenderAlert("alert-2", {
    properties: {
      alertDisplayName: "Unusual data transfer volume",
      description: "Outbound traffic exceeded the learned baseline.",
      severity: "Medium",
      status: "Active",
      timeGeneratedUtc: "2026-09-29T10:00:00.000Z",
      remediationSteps: ["Review flow logs"],
      resourceIdentifiers: [
        {
          azureResourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Storage/storageAccounts/st1`,
        },
      ],
      entities: [],
    },
  }),
];

export const defenderAlertDetail = defenderAlert("alert-1");

// source: securityinsights stable/2025-09-01 examples/incidents/GetIncidents.json
// and the incidents list REST reference (identifiers replaced).
const sentinelIncident = (name: string, incidentNumber: number, overrides: Record<string, unknown> = {}) => ({
  id: `${discoveryGroup.id}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/${name}`,
  name,
  type: "Microsoft.SecurityInsights/incidents",
  etag: '"00000000-0000-0000-0000-000000000099"',
  properties: {
    lastModifiedTimeUtc: "2026-09-30T13:15:30Z",
    createdTimeUtc: "2026-09-30T13:15:30Z",
    lastActivityTimeUtc: "2026-09-30T13:05:30Z",
    firstActivityTimeUtc: "2026-09-30T13:00:30Z",
    description: "A demo incident raised by the analytics rule.",
    title: "Suspicious sign-in activity",
    owner: { objectId: SYN(80), email: "hunter@contoso.com", userPrincipalName: "hunter@contoso.com", assignedTo: "Casey Hunter" },
    severity: "High",
    status: "Active",
    incidentUrl: "https://portal.azure.com/#asset/Microsoft_Azure_Security_Insights/Incident",
    incidentNumber,
    labels: [{ labelName: "reviewed", labelType: "User" }],
    providerName: "Azure Sentinel",
    providerIncidentId: String(incidentNumber),
    additionalData: { alertsCount: 3, bookmarksCount: 0, commentsCount: 1, alertProductNames: ["Azure Security Center"], tactics: ["Persistence"] },
  },
  ...overrides,
});

export const sentinelIncidents = [
  sentinelIncident(SYN(90), 3177),
  sentinelIncident(SYN(91), 3176, {
    properties: {
      lastModifiedTimeUtc: "2026-09-29T10:00:00Z",
      createdTimeUtc: "2026-09-29T10:00:00Z",
      lastActivityTimeUtc: "2026-09-29T09:00:00Z",
      firstActivityTimeUtc: "2026-09-29T08:00:00Z",
      description: "Outbound traffic exceeded the learned baseline.",
      title: "Unusual data transfer volume",
      severity: "Medium",
      status: "New",
      incidentNumber: 3176,
      labels: [],
      providerName: "Azure Sentinel",
      providerIncidentId: "3176",
      additionalData: { alertsCount: 1, bookmarksCount: 0, commentsCount: 0, alertProductNames: [], tactics: [] },
    },
  }),
];

export const sentinelIncidentDetail = sentinelIncidents[0];

// source: securityinsights stable/2025-09-01 examples/incidents/GetAllIncidentAlerts.json
// (Incidents_ListAlerts response shape `{ value: SecurityAlert[] }`, identifiers replaced).
const sentinelIncidentAlert = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: `${discoveryGroup.id}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/Entities/${name}`,
  name,
  type: "Microsoft.SecurityInsights/Entities",
  kind: "SecurityAlert",
  properties: {
    systemAlertId: name,
    tactics: ["Persistence"],
    alertDisplayName: "myAlert",
    confidenceLevel: "Unknown",
    severity: "Low",
    vendorName: "Microsoft",
    productName: "Azure Security Center",
    alertType: "myAlert",
    status: "New",
    endTimeUtc: "2026-09-30T13:15:30Z",
    startTimeUtc: "2026-09-30T13:00:30Z",
    timeGenerated: "2026-09-30T13:15:30Z",
    resourceIdentifiers: [{ type: "LogAnalytics", workspaceId: WORKSPACE, subscriptionId: SUB_A, resourceGroup: "rg-demo" }],
    friendlyName: "myAlert",
  },
  ...overrides,
});

export const sentinelIncidentAlerts = [
  sentinelIncidentAlert(SYN(92)),
  sentinelIncidentAlert(SYN(93), { properties: {
    systemAlertId: SYN(93),
    tactics: ["Exfiltration"],
    alertDisplayName: "Unusual outbound volume",
    confidenceLevel: "High",
    severity: "Medium",
    vendorName: "Microsoft",
    productName: "Azure Security Center",
    alertType: "outboundVolume",
    status: "Active",
    endTimeUtc: "2026-09-29T10:00:00Z",
    startTimeUtc: "2026-09-29T08:00:00Z",
    timeGenerated: "2026-09-29T10:00:00Z",
    resourceIdentifiers: [],
    friendlyName: "Unusual outbound volume",
  } }),
];

// source: securityinsights stable/2025-09-01 examples/incidents/GetAllIncidentEntities.json
// (Incidents_ListEntities response shape `{ entities, metaData }`, identifiers replaced).
export const sentinelIncidentEntities = {
  entities: [{
    id: `${discoveryGroup.id}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/Entities/${SYN(94)}`,
    name: SYN(94),
    type: "Microsoft.SecurityInsights/Entities",
    kind: "Account",
    properties: {
      friendlyName: "administrator",
      accountName: "administrator",
      ntDomain: "contoso",
    },
  }, {
    id: `${discoveryGroup.id}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/Entities/${SYN(95)}`,
    name: SYN(95),
    type: "Microsoft.SecurityInsights/Entities",
    kind: "Host",
    properties: {
      friendlyName: "contoso-vm",
      hostName: "contoso-vm",
      dnsDomain: "contoso.com",
    },
  }],
  metaData: [{ entityKind: "Account", count: 1 }, { entityKind: "Host", count: 1 }],
};

// source: securityinsights stable/2025-09-01 examples/alertRules/GetScheduledAlertRuleById.json
// and GetMicrosoftSecurityIncidentCreationAlertRuleById.json
// (AlertRules_List response shape `{ value: AlertRule[] }`, identifiers replaced).
const sentinelAlertRule = (name: string, kind: string, properties: Record<string, unknown>) => ({
  id: `${discoveryGroup.id}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/alertRules/${name}`,
  name,
  type: "Microsoft.SecurityInsights/alertRules",
  kind,
  properties,
});

export const sentinelAlertRules = [
  sentinelAlertRule(SYN(96), "Scheduled", {
    displayName: "Suspicious sign-in burst",
    description: "Raises an incident when one account fails to sign in from many locations in a short window. Tune the failure and location thresholds per site before enabling the scheduled run, and exclude service accounts that roam by design.",
    severity: "High",
    enabled: true,
    query: "SigninLogs | where ResultType != 0 | summarize failures = count(), locations = dcount(Location), apps = dcount(AppDisplayName) by UserPrincipalName, bin(TimeGenerated, 15m) | where failures > 10 and locations > 3 | order by failures desc",
    queryFrequency: "PT15M",
    queryPeriod: "PT1H",
    triggerOperator: "GreaterThan",
    triggerThreshold: 10,
    tactics: ["InitialAccess"],
    alertRuleTemplateName: SYN(61),
    lastModifiedUtc: "2026-09-30T13:15:30Z",
  }),
  sentinelAlertRule(SYN(97), "MicrosoftSecurityIncidentCreation", {
    displayName: "Create incidents from Defender alerts",
    description: "Creates a Sentinel incident for every matching Defender for Cloud alert.",
    enabled: false,
    productFilter: "Azure Security Center",
    alertRuleTemplateName: SYN(62),
    lastModifiedUtc: "2026-09-29T10:00:00Z",
  }),
];

export const sentinelAlertRuleDetail = sentinelAlertRules[0];

// source: securityinsights stable/2025-09-01 examples/dataConnectors/
// (DataConnectors_List response shape `{ value: DataConnector[] }`, identifiers replaced).
// The Office365 entry carries credential-shaped decoy fields: only safelisted
// metadata may ever reach output rows, so these values assert omission.
const sentinelDataConnector = (name: string, kind: string, properties: Record<string, unknown>) => ({
  id: `${discoveryGroup.id}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/dataConnectors/${name}`,
  name,
  type: "Microsoft.SecurityInsights/dataConnectors",
  kind,
  properties,
});

export const sentinelDataConnectors = [
  sentinelDataConnector(SYN(98), "AzureActiveDirectory", {
    tenantId: TENANT,
    dataTypes: { alerts: { state: "Connected" } },
    lastModifiedUtc: "2026-09-30T13:15:30Z",
  }),
  sentinelDataConnector(SYN(99), "Office365", {
    tenantId: TENANT,
    dataTypes: { exchange: { state: "Connected" }, sharePoint: { state: "Disconnected" } },
    password: "never-output-this-value",
    apiKey: "never-output-this-value",
    connectionString: "never-output-this-value",
    lastModifiedUtc: "2026-09-29T10:00:00Z",
  }),
];

export const sentinelDataConnectorDetail = sentinelDataConnectors[0];

// source: Defender for Cloud Resource Graph samples for securityresources (identifiers replaced)
const assessment = (recommendation: string, severity: string, status: string, resource: string) => ({
  recommendation,
  severity,
  status,
  resourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/${resource}`,
  subscriptionId: SUB_A,
  id: `/subscriptions/${SUB_A}/providers/Microsoft.Security/assessments/${SYN(50)}`,
});

export const defenderAssessments = [
  assessment("MFA should be enabled", "High", "Unhealthy", "Microsoft.Compute/virtualMachines/vm1"),
  assessment("MFA should be enabled", "High", "Unhealthy", "Microsoft.Compute/virtualMachines/vm2"),
  assessment("Auditing should be enabled", "Medium", "Unhealthy", "Microsoft.Storage/storageAccounts/st1"),
  assessment("Auditing should be enabled", "Medium", "Healthy", "Microsoft.Storage/storageAccounts/st2"),
];

// source: security/stable/2020-01-01/examples/secureScore.json (Resource Graph shape)
export const defenderScores = [
  {
    subscriptionId: SUB_A,
    current: 42.5,
    max: 100,
    percent: 42.5,
    id: `/subscriptions/${SUB_A}/providers/Microsoft.Security/secureScores/ascScore`,
  },
  {
    subscriptionId: SUB_B,
    current: 90,
    max: 100,
    percent: 90,
    id: `/subscriptions/${SUB_B}/providers/Microsoft.Security/secureScores/ascScore`,
  },
];

// source: Resource Graph starter samples, network shapes (identifiers replaced)
export const exposurePublicIps = [
  {
    resource: "pip-1",
    resourceGroup: "rg-demo",
    subscriptionId: SUB_A,
    detail: `10.0.0.1 -> /subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/networkInterfaces/nic-1`,
    id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/publicIPAddresses/pip-1`,
  },
  {
    resource: "pip-2",
    resourceGroup: "rg-demo",
    subscriptionId: SUB_A,
    detail: `10.0.0.2 -> /subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/networkInterfaces/nic-2`,
    id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/publicIPAddresses/pip-2`,
  },
];

export const exposureMgmtPorts = [
  {
    resource: "nsg-1",
    resourceGroup: "rg-demo",
    subscriptionId: SUB_A,
    detail: "rule ssh src * ports 22",
    id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/networkSecurityGroups/nsg-1`,
  },
];

export const exposureAnyAny = [
  {
    resource: "nsg-2",
    resourceGroup: "rg-demo",
    subscriptionId: SUB_A,
    detail: "rule open src * ports *",
    id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/networkSecurityGroups/nsg-2`,
  },
];

// source: Log Analytics query response shape (identifiers replaced)
export const logsResponse = {
  tables: [
    {
      name: "PrimaryResult",
      columns: [
        { name: "TimeGenerated", type: "datetime" },
        { name: "ResultType", type: "string" },
        { name: "Count", type: "long" },
      ],
      rows: [
        ["2026-09-30T00:00:00Z", "Success", 41],
        ["2026-09-30T01:00:00Z", "Success", 37],
        ["2026-09-30T02:00:00Z", "Failure", 2],
      ],
    },
    {
      name: "QueryCompletionInformation",
      columns: [{ name: "code", type: "string" }],
      rows: [["Done"]],
    },
  ],
};

// source: resources/subscriptions/list response shape (identifiers replaced)
export const apiListResponse = {
  value: [
    { id: `/subscriptions/${SUB_A}`, subscriptionId: SUB_A, displayName: "Sandbox", state: "Enabled" },
    { id: `/subscriptions/${SUB_B}`, subscriptionId: SUB_B, displayName: "Lab", state: "Enabled" },
  ],
};

// source: Resource Groups - Get, resources/resource-manager/Microsoft.Resources@2021-04-01 (synthetic).
export const apiWriteState = { name: "rg-demo", location: "westus", tags: { env: "dev" } };
export const apiWriteBody = { tags: { env: "prod" } };

// Dashboard alert-count rows for the home command (Resource Graph shape).
export const homeAlertCounts = [
  { severity: "High", alerts: 2 },
  { severity: "Medium", alerts: 1 },
];

// Identity reported by `az account show` in doctor and home fixtures.
export const sampleIdentity = { name: "analyst@contoso.com", type: "user", tenantId: TENANT };

// Profiles shown by `config list` in the budget fixture.
export const configListProfiles = {
  defaultProfile: "work",
  profiles: {
    work: { auth: "az", tenant: TENANT, managementGroup: "contoso-root", description: "Daily analyst profile" },
    sandbox: { auth: "az", subscriptions: [SUB_A], allowWrites: true, description: "Writes enabled, sandbox only" },
    ci: { auth: "token" },
  },
};

// source: network/resource-manager/Microsoft.Network/stable/2024-05-01/examples/
// NetworkSecurityGroupList.json, NetworkInterfaceList.json, VirtualNetworkList.json,
// PublicIPAddressList.json and PrivateEndpointList.json (response shape
// `{ value: T[] }`, identifiers replaced).
const networkId = (collection: string, name: string) =>
  `${discoveryGroup.id}/providers/Microsoft.Network/${collection}/${name}`;
export const networkNsg = {
  id: networkId("networkSecurityGroups", "nsg-web"), name: "nsg-web",
  type: "Microsoft.Network/networkSecurityGroups", location: "westus", tags: { env: "test" },
  properties: {
    provisioningState: "Succeeded",
    securityRules: [
      { name: "allow-https", id: `${networkId("networkSecurityGroups", "nsg-web")}/securityRules/allow-https`,
        properties: { description: "Allow HTTPS from the internet", protocol: "Tcp", sourcePortRange: "*",
          destinationPortRange: "443", sourceAddressPrefix: "Internet", destinationAddressPrefix: "*",
          access: "Allow", priority: 100, direction: "Inbound" } },
      { name: "deny-ssh-any", id: `${networkId("networkSecurityGroups", "nsg-web")}/securityRules/deny-ssh-any`,
        properties: { protocol: "*", sourcePortRange: "*", destinationPortRanges: ["22", "3389"],
          sourceAddressPrefixes: ["0.0.0.0/0"], destinationAddressPrefix: "*",
          access: "Deny", priority: 200, direction: "Inbound" } },
      { name: "allow-sql-app", id: `${networkId("networkSecurityGroups", "nsg-web")}/securityRules/allow-sql-app`,
        properties: { protocol: "Tcp", sourcePortRange: "*", destinationPortRange: "1433",
          sourceApplicationSecurityGroups: [{ id: networkId("applicationSecurityGroups", "asg-app") }],
          destinationAddressPrefix: "10.0.1.0/24", access: "Allow", priority: 300, direction: "Inbound" } },
    ],
    defaultSecurityRules: [{ name: "AllowVnetInBound", properties: { access: "Allow", priority: 65000, direction: "Inbound" } }],
    subnets: [{ id: `${networkId("virtualNetworks", "vnet-demo")}/subnets/default` }],
    networkInterfaces: [{ id: networkId("networkInterfaces", "nic-demo") }],
  },
};
export const networkNsgs = [networkNsg, {
  id: networkId("networkSecurityGroups", "nsg-empty"), name: "nsg-empty",
  type: "Microsoft.Network/networkSecurityGroups", location: "westeurope",
  properties: { provisioningState: "Succeeded", securityRules: [], subnets: [], networkInterfaces: [] },
}];
export const networkNic = {
  id: networkId("networkInterfaces", "nic-demo"), name: "nic-demo",
  type: "Microsoft.Network/networkInterfaces", location: "westus",
  properties: {
    provisioningState: "Succeeded", macAddress: "00-11-22-33-44-55", enableIPForwarding: false,
    virtualMachine: { id: `${discoveryGroup.id}/providers/Microsoft.Compute/virtualMachines/vm1` },
    networkSecurityGroup: { id: networkId("networkSecurityGroups", "nsg-web") },
    dnsSettings: { internalDnsNameLabel: "nic-demo" },
    ipConfigurations: [
      { name: "ipconfig1", properties: { privateIPAddress: "10.0.1.4", privateIPAllocationMethod: "Dynamic",
        subnet: { id: `${networkId("virtualNetworks", "vnet-demo")}/subnets/default` },
        publicIPAddress: { id: networkId("publicIPAddresses", "pip-demo") } } },
    ],
  },
};
export const networkNics = [networkNic];
export const networkVnet = {
  id: networkId("virtualNetworks", "vnet-demo"), name: "vnet-demo",
  type: "Microsoft.Network/virtualNetworks", location: "westus",
  properties: {
    provisioningState: "Succeeded",
    addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
    dhcpOptions: { dnsServers: ["10.0.0.10"] },
    subnets: [
      { name: "default", id: `${networkId("virtualNetworks", "vnet-demo")}/subnets/default`,
        properties: { addressPrefix: "10.0.1.0/24",
          networkSecurityGroup: { id: networkId("networkSecurityGroups", "nsg-web") } } },
      { name: "data", id: `${networkId("virtualNetworks", "vnet-demo")}/subnets/data`,
        properties: { addressPrefixes: ["10.0.2.0/24"],
          routeTable: { id: networkId("routeTables", "rt-demo") } } },
    ],
    virtualNetworkPeerings: [
      { name: "hub-peer", properties: { peeringState: "Connected",
        remoteVirtualNetwork: { id: networkId("virtualNetworks", "vnet-hub") } } },
    ],
  },
};
export const networkVnets = [networkVnet];
export const networkPublicIp = {
  id: networkId("publicIPAddresses", "pip-demo"), name: "pip-demo",
  type: "Microsoft.Network/publicIPAddresses", location: "westus",
  sku: { name: "Standard", tier: "Regional" }, zones: ["1"],
  properties: {
    provisioningState: "Succeeded", publicIPAllocationMethod: "Static", publicIPAddressVersion: "IPv4",
    ipAddress: "203.0.113.10", idleTimeoutInMinutes: 4,
    dnsSettings: { domainNameLabel: "pip-demo", fqdn: "pip-demo.westus.cloudapp.azure.com" },
    ipConfiguration: { id: `${networkId("networkInterfaces", "nic-demo")}/ipConfigurations/ipconfig1` },
  },
};
export const networkPublicIps = [networkPublicIp, {
  id: networkId("publicIPAddresses", "pip-free"), name: "pip-free",
  type: "Microsoft.Network/publicIPAddresses", location: "westeurope",
  sku: { name: "Basic" },
  properties: { provisioningState: "Succeeded", publicIPAllocationMethod: "Dynamic" },
}];
export const networkPrivateEndpoint = {
  id: networkId("privateEndpoints", "pe-storage"), name: "pe-storage",
  type: "Microsoft.Network/privateEndpoints", location: "westus",
  properties: {
    provisioningState: "Succeeded",
    subnet: { id: `${networkId("virtualNetworks", "vnet-demo")}/subnets/data` },
    networkInterfaces: [{ id: networkId("networkInterfaces", "pe-storage.nic.demo") }],
    privateLinkServiceConnections: [
      { name: "pe-storage", properties: {
        privateLinkServiceId: `${discoveryGroup.id}/providers/Microsoft.Storage/storageAccounts/stexample`,
        groupIds: ["blob"],
        privateLinkServiceConnectionState: { status: "Approved", description: "Auto-approved", actionsRequired: "None" } } },
    ],
    customDnsConfigs: [{ fqdn: "stexample.blob.core.windows.net", ipAddresses: ["10.0.2.4"] }],
  },
};
export const networkPrivateEndpoints = [networkPrivateEndpoint];

// source: network/resource-manager/Microsoft.Network/stable/2018-05-01/examples/
// ZoneListByResourceGroup.json, ZoneGet.json, ListByDnsZone.json and GetARecordset.json
// (response shapes `{ value: T[] }`, identifiers replaced).
export const networkDnsZone = {
  id: `${discoveryGroup.id}/providers/Microsoft.Network/dnszones/example.com`, name: "example.com",
  type: "Microsoft.Network/dnszones", location: "global", tags: { env: "test" },
  properties: { maxNumberOfRecordSets: 10000, numberOfRecordSets: 3,
    nameServers: ["ns1.example.com.", "ns2.example.com."] },
};
export const networkDnsZones = [networkDnsZone];
const dnsRecordSetId = (zone: string, type: string, name: string) =>
  `${discoveryGroup.id}/providers/Microsoft.Network/dnszones/${zone}/${type}/${name}`;
export const networkDnsRecordSets = [
  { id: dnsRecordSetId("example.com", "A", "www"), name: "www", type: "Microsoft.Network/dnszones/A",
    properties: { TTL: 3600, fqdn: "www.example.com.", ARecords: [{ ipv4Address: "203.0.113.10" }], metadata: { env: "prod" } } },
  { id: dnsRecordSetId("example.com", "CNAME", "shop"), name: "shop", type: "Microsoft.Network/dnszones/CNAME",
    properties: { TTL: 300, fqdn: "shop.example.com.", CNAMERecord: { cname: "shop.contoso.com." } } },
  { id: dnsRecordSetId("example.com", "TXT", "@"), name: "@", type: "Microsoft.Network/dnszones/TXT",
    properties: { TTL: 3600, fqdn: "example.com.", TXTRecords: [{ value: ["v=spf1 include:contoso.com ~all"] }] } },
];
export const networkDnsRecordSetDetail = networkDnsRecordSets[0];

// source: resources/resource-manager/Microsoft.Authorization/policy/stable/2021-06-01/examples/
// createPolicyAssignment_* and getPolicyAssignment_* (response shape `{ value: T[] }`,
// identifiers replaced). The unfiltered subscription list also carries inherited scopes.
const policyScopeId = (collection: string, name: string) =>
  `/subscriptions/${SUB_A}/providers/Microsoft.Authorization/${collection}/${name}`;
export const policyAssignment = {
  id: policyScopeId("policyAssignments", "CostManagement"), name: "CostManagement",
  type: "Microsoft.Authorization/policyAssignments",
  properties: {
    displayName: "Storage Cost Management", description: "Minimize the risk of accidental cost overruns",
    policyDefinitionId: policyScopeId("policyDefinitions", "ResourceNaming"),
    scope: `/subscriptions/${SUB_A}`, enforcementMode: "Default",
    parameters: { allowedSkus: { value: "Standard_A1" } },
    nonComplianceMessages: [{ message: "Storage SKU is not approved" }],
  },
};
export const policyAssignments = [policyAssignment, {
  id: `${discoveryGroup.id}/providers/Microsoft.Authorization/policyAssignments/TagEnforcement`,
  name: "TagEnforcement", type: "Microsoft.Authorization/policyAssignments",
  properties: {
    displayName: "Enforces a tag key and value", description: "Ensure a given tag key and value are present",
    policyDefinitionId: `/providers/Microsoft.Authorization/policyDefinitions/${SYN(42)}`,
    scope: discoveryGroup.id, enforcementMode: "DoNotEnforce", parameters: {}, nonComplianceMessages: [],
  },
}];
// source: resources/resource-manager/Microsoft.Authorization/policy/stable/2021-06-01/examples/
// createPolicyDefinition_* and getPolicyDefinition_* (identifiers replaced). The
// subscription list carries built-in definitions with tenant-scoped IDs alongside customs.
export const policyDefinition = {
  id: `/providers/Microsoft.Authorization/policyDefinitions/${SYN(42)}`,
  name: SYN(42), type: "Microsoft.Authorization/policyDefinitions",
  properties: {
    displayName: "Allowed storage account SKUs", description: "Specify a set of storage account SKUs to deploy",
    mode: "All", policyType: "BuiltIn", version: "1.2.1", metadata: { category: "Storage" },
    policyRule: { if: { field: "type", equals: "Microsoft.Storage/storageAccounts" }, then: { effect: "Deny" } },
    parameters: { listOfAllowedSKUs: { type: "Array", metadata: { displayName: "Allowed SKUs" } } },
  },
};
export const policyDefinitions = [policyDefinition, {
  id: policyScopeId("policyDefinitions", "ResourceNaming"), name: "ResourceNaming",
  type: "Microsoft.Authorization/policyDefinitions",
  properties: {
    displayName: "Naming Convention", description: "Force resource names to begin with a prefix",
    mode: "All", policyType: "Custom", version: "1.0.0", metadata: { category: "Naming" },
    policyRule: { if: { field: "name", like: "prefix*suffix" }, then: { effect: "deny" } },
    parameters: { prefix: { type: "String", metadata: { displayName: "Prefix" } } },
  },
}];
// source: resources/resource-manager/Microsoft.Authorization/policy/stable/2021-06-01/examples/
// createPolicySetDefinition_* and getPolicySetDefinition_* (identifiers replaced).
export const policySetDefinition = {
  id: `/providers/Microsoft.Authorization/policySetDefinitions/${SYN(43)}`,
  name: SYN(43), type: "Microsoft.Authorization/policySetDefinitions",
  properties: {
    displayName: "Audit public network access", description: "Audit storage and SQL public access",
    policyType: "BuiltIn", metadata: { category: "Network" },
    policyDefinitions: [
      { policyDefinitionId: `/providers/Microsoft.Authorization/policyDefinitions/${SYN(42)}`,
        policyDefinitionReferenceId: "storageSkus" },
      { policyDefinitionId: policyScopeId("policyDefinitions", "ResourceNaming"),
        policyDefinitionReferenceId: "naming" },
    ],
    parameters: {},
  },
};
export const policySetDefinitions = [policySetDefinition];
// source: learn.microsoft.com/rest/api/policyinsights/policy-states/list-query-results-for-subscription
// (2024-10-01 "Query latest at subscription scope" example, identifiers replaced).
// The POST envelope is `{ value: PolicyState[], @odata.count, @odata.nextLink }`.
export const policyStates = [
  { complianceState: "NonCompliant", isCompliant: false,
    policyAssignmentId: policyScopeId("policyAssignments", "CostManagement"),
    policyAssignmentName: "CostManagement", policyAssignmentScope: `/subscriptions/${SUB_A}`,
    policyDefinitionAction: "Audit", policyDefinitionId: policyScopeId("policyDefinitions", "storageSkus"),
    policyDefinitionName: "storageSkus",
    resourceId: `${discoveryGroup.id}/providers/Microsoft.Network/publicIPAddresses/mypubip1`,
    resourceGroup: "rg-demo", subscriptionId: SUB_A, timestamp: "2026-10-03T17:48:05Z" },
  { complianceState: "Compliant", isCompliant: true,
    policyAssignmentId: `${discoveryGroup.id}/providers/Microsoft.Authorization/policyAssignments/TagEnforcement`,
    policyAssignmentName: "TagEnforcement", policyAssignmentScope: discoveryGroup.id,
    policyDefinitionAction: "Modify", policyDefinitionId: policyScopeId("policyDefinitions", "ResourceNaming"),
    policyDefinitionName: "ResourceNaming",
    resourceId: `${discoveryGroup.id}/providers/Microsoft.Storage/storageAccounts/mysa1`,
    resourceGroup: "rg-demo", subscriptionId: SUB_A, timestamp: "2026-10-03T18:02:11Z" },
];
export const policyStateEnvelope = (value: unknown[], count: number, nextLink: string | null) =>
  ({ value, "@odata.count": count, "@odata.nextLink": nextLink });
