export const scenarios = [
  { name: "account-list", argv: ["account", "list"] },
  { name: "account-show", argv: ["account", "show"] },
  { name: "workspace-list", argv: ["monitor", "log-analytics", "workspace", "list"] },
  { name: "workspace-show", ownerTarget: "workspaceResourceId", argv: ["monitor", "log-analytics", "workspace", "show", "--ids", "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-demo/providers/Microsoft.OperationalInsights/workspaces/logs-demo"] },
  { name: "group-list", argv: ["group", "list"] },
  { name: "group-show", ownerTarget: "resourceGroup", argv: ["group", "show", "--name", "rg-demo"] },
  { name: "resource-list", argv: ["resource", "list"] },
  { name: "resource-show", ownerTarget: "resourceId", argv: ["resource", "show", "--ids", "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm1", "--api-version", "2024-07-01"] },
  ...[1, 10, 50].map((rows) => ({
    name: `rg-${rows}`,
    argv: ["rg", "query", `Resources | take ${rows}`, "--limit", String(rows)],
  })),
  { name: "rbac-privileged", argv: ["rbac", "list", "--privileged"] },
  { name: "role-assignment-privileged", argv: ["role", "assignment", "list", "--privileged"] },
  { name: "monitor-activity", argv: ["monitor", "activity-log", "list", "--offset", "24h"] },
  { name: "security-alerts", argv: ["security", "alert", "list"] },
  { name: "sentinel-incidents", argv: ["sentinel", "incident", "list", "--workspace", "benchmark"] },
  { name: "sentinel-alert-rules", argv: ["sentinel", "alert-rule", "list", "--workspace", "benchmark"] },
  { name: "sentinel-data-connectors", argv: ["sentinel", "data-connector", "list", "--workspace", "benchmark"] },
  { name: "security-scores", argv: ["security", "secure-scores", "list"] },
  { name: "defender-alerts", argv: ["defender", "alerts"] },
  { name: "exposure", argv: ["exposure"] },
  { name: "logs-query", argv: ["logs", "query", "SigninLogs | take 50", "--workspace", "benchmark"] },
  { name: "graph-query", argv: ["graph", "query", "-q", "Resources | take 50", "--first", "50"] },
  { name: "monitor-log-analytics-query", argv: ["monitor", "log-analytics", "query", "--analytics-query", "SigninLogs | take 50", "--workspace", "benchmark"] },
];

// Measured by test/budget.test.ts with fake transport and a synthetic writer profile.
// Owner capture/replay stays read-only and never includes native write previews.
export const offlineWritePreviews = [
  { name: "security-alert-update", argv: ["security", "alert", "update", "--location", "westeurope", "--name", "example-alert", "--status", "dismiss"] },
  { name: "sentinel-incident-update", argv: ["sentinel", "incident", "update", "--name", "00000000-0000-0000-0000-000000000063", "--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--status", "closed", "--classification", "FalsePositive", "--classification-reason", "IncorrectAlertLogic"] },
  { name: "sentinel-incident-comment-create", argv: ["sentinel", "incident", "comment", "create", "--incident-id", "00000000-0000-0000-0000-000000000063", "--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--message", "Offline triage note"] },
];

// Child transport is exercised with fake az responses in the offline budget suite.
export const offlinePassthroughReads = [
  { name: "az-group-show", argv: ["az", "group", "show", "--name", "rg-demo"] },
];

// ACR metadata shapes are measured offline without data-plane access.
export const offlineAcrReads = [
  { name: "acr-repository-list", kind: "repository", argv: ["acr", "repository", "list", "--name", "myregistry"] },
  { name: "acr-repository-show-tags", kind: "tag", argv: ["acr", "repository", "show-tags", "--name", "myregistry", "--repository", "hello-world"] },
  { name: "acr-manifest-show-metadata", kind: "manifest", argv: ["acr", "manifest", "show-metadata", "--registry", "myregistry", "--name", "hello-world:latest"] },
];
// Storage metadata shapes are measured offline without data-plane access.
export const offlineStorageReads = [
  { name: "storage-container-list", argv: ["storage", "container", "list", "--account-name", "stexample"] },
  { name: "storage-container-show", argv: ["storage", "container", "show", "--account-name", "stexample", "--name", "example"] },
  { name: "storage-blob-list", argv: ["storage", "blob", "list", "--account-name", "stexample", "--container-name", "example"] },
  { name: "storage-blob-show", argv: ["storage", "blob", "show", "--account-name", "stexample", "--container-name", "example", "--name", "example"] },
];

// Key Vault property listings are measured offline without data-plane access.
export const offlineKeyvaultReads = [
  { name: "keyvault-secret-list", argv: ["keyvault", "secret", "list", "--vault-name", "kvexample"] },
  { name: "keyvault-key-list", argv: ["keyvault", "key", "list", "--vault-name", "kvexample"] },
  { name: "keyvault-certificate-list", argv: ["keyvault", "certificate", "list", "--vault-name", "kvexample"] },
];
