export const scenarios = [
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
];
