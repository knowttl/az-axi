export const scenarios = [
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
];

// Child transport is exercised with fake az responses in the offline budget suite.
export const offlinePassthroughReads = [
  { name: "az-group-show", argv: ["az", "group", "show", "--name", "rg-demo"] },
];
