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
  id: "https://kvexample.vault.azure.net/secrets/example-secret/abc123", contentType: "text/plain",
  attributes: { enabled: true, created: 1791072000, updated: 1791072000, exp: 1793664000, nbf: 1790985600 },
  tags: { owner: "never-output-this-value" }, managed: false, value: "never-output-this-value",
}] });
export const keyvaultKeys = JSON.stringify({ value: [{
  kid: "https://kvexample.vault.azure.net/keys/example-key/abc123",
  attributes: { enabled: true, created: 1791072000, updated: 1791072000, exp: 1793664000 },
  tags: { owner: "never-output-this-value" }, managed: true, key: { kty: "never-output-this-value" },
}] });
export const keyvaultCertificates = JSON.stringify({ value: [{
  id: "https://kvexample.vault.azure.net/certificates/example-cert/abc123", x5t: "dGVzdA",
  attributes: { enabled: false, created: 1791072000, updated: 1791072000 },
  tags: { owner: "never-output-this-value" }, managed: false, cer: "never-output-this-value",
}] });
export const keyvaultMetadataRows = {
  secret: { name: "example-secret", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z", notBefore: "2026-10-03T00:00:00.000Z", created: "2026-10-04T00:00:00.000Z", updated: "2026-10-04T00:00:00.000Z", contentType: "text/plain", managed: false },
  key: { name: "example-key", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z", notBefore: "", created: "2026-10-04T00:00:00.000Z", updated: "2026-10-04T00:00:00.000Z", managed: true },
  certificate: { name: "example-cert", enabled: false, expiresOn: "", notBefore: "", created: "2026-10-04T00:00:00.000Z", updated: "2026-10-04T00:00:00.000Z", thumbprint: "dGVzdA", managed: false },
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
