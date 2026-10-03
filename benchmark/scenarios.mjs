export const scenarios = [
  ...[1, 10, 50].map((rows) => ({
    name: `rg-${rows}`,
    argv: ["rg", "query", `Resources | take ${rows}`, "--limit", String(rows)],
  })),
  { name: "rbac-privileged", argv: ["rbac", "list", "--privileged"] },
  { name: "defender-alerts", argv: ["defender", "alerts"] },
  { name: "exposure", argv: ["exposure"] },
  { name: "logs-query", argv: ["logs", "query", "SigninLogs | take 50", "--workspace", "benchmark"] },
];
