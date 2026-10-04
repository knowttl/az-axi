const SELECTORS: Record<string, string> = {
  "monitor metrics alert list": "--resource-group / -g scopes the list; --name / -n filters one exact rule name.",
  "monitor metrics alert show": "--name / -n takes the rule name with --resource-group / -g in one subscription, or --ids <rule-ARM-id> alone.",
  "monitor action-group list": "--resource-group / -g scopes the list; --name / -n filters one exact action-group name.",
  "monitor action-group show": "--name / -n takes the action-group name with --resource-group / -g in one subscription, or --ids <action-group-ARM-id> alone.",
  "monitor diagnostic-settings list": "--resource takes exactly one ARM resource, resource-group or subscription ID whose diagnostic settings are listed.",
  "monitor diagnostic-settings show": "--resource plus --name / -n takes one setting in one subscription, or --ids <setting-ARM-id> alone.",
  "monitor metrics list": "--resource takes exactly one ARM resource ID. --metric <name> selects metric values; without it the command lists metric definitions. --start-time/--end-time bound the window (default last hour, at most 31 days).",
};

const DETAIL: Record<string, string> = {
  "monitor metrics alert list": "Rows default to name, severity, enabled, scopes and criteria (metric, operator, threshold), with bySeverity and byEnabled counts. Webhook action properties arrive as names only.",
  "monitor metrics alert show": "Show returns the description, severity, enabled state, scopes, evaluation frequency, window size, criteria and action-group targets. Rule create, update, delete and status actions stay out.",
  "monitor action-group list": "Rows default to name, enabled, shortName and receivers (type counts), with byEnabled counts.",
  "monitor action-group show": "Show returns the group short name, enabled state and receivers with safelisted metadata only: webhook URLs without userinfo, query or fragment, webhook property names without values. Test-notification and receiver-enable actions stay out.",
  "monitor diagnostic-settings list": "Rows default to name, logs (enabled categories or category groups), metrics (enabled categories or category groups) and destinations (storage account, workspace, event hub, marketplace partner). One target resource only.",
  "monitor diagnostic-settings show": "Show returns the log and metric categories and category groups with enabled flags and retention, plus the storage, workspace, event-hub and marketplace partner destinations. Setting create, update and delete stay out.",
  "monitor metrics list": "Without --metric, rows default to metric, unit and aggregations (supported aggregation types) for the resource. With --metric, rows default to metric, unit, points, latest aggregation values and time over the bounded window; --full expands every returned point with named aggregation values. Metric query errors fail the command. Dimension filters and subscription-scope batch queries stay out.",
};

const FIELDS: Record<string, string> = {
  "monitor metrics alert list": "--fields: name, severity, enabled, scopes, criteria.",
  "monitor metrics alert show": "--fields: name, id, description, severity, enabled, scopes, frequency, window, criteria, actions.",
  "monitor action-group list": "--fields: name, enabled, shortName, receivers.",
  "monitor action-group show": "--fields: name, id, shortName, enabled, receivers.",
  "monitor diagnostic-settings list": "--fields: name, logs, metrics, destinations.",
  "monitor diagnostic-settings show": "--fields: name, id, logs, metrics, storage, workspace, eventHub, partner.",
  "monitor metrics list": "--fields: metric, unit, aggregations, points, latest, time, from, to.",
};

export function monitorLeafHelp(path: string): string {
  const show = path.endsWith(" show");
  return [
    `Command: az-axi ${path}`,
    `az-axi ${path} ${SELECTORS[path] ?? ""}`.trimEnd(),
    "Read-only Azure Monitor GETs against Microsoft.Insights: metric alerts use api-version 2026-01-01; action groups use api-version 2023-01-01; diagnostic settings use api-version 2021-05-01-preview (the only version); metrics definitions and values use api-version 2024-02-01. Management-group scope is unsupported; select subscriptions explicitly.",
    "Subscription and resource-group lists fan out across the selected subscriptions (flags, environment, profile, else all accessible) with exact --name / -n filtering. Diagnostic settings and metrics target exactly one --resource <ARM-id>. --limit defaults to 50; --full shows every fetched row. ARM lists follow up to 100 pages per subscription; incomplete counts are disclosed as lower bounds.",
    "Show by name needs exactly one subscription. --ids takes exactly one ARM ID of the same collection and uses the ID's subscription when one is present.",
    DETAIL[path] ?? "",
    "--fields selects listed fields and takes precedence over --full; --full expands safe metadata and shows every fetched row. No view returns secrets, keys, webhook secrets or credential fields.",
    FIELDS[path] ?? "",
    "No native Monitor mutation commands are available; rule, action-group, setting and metric changes stay on generic api writes behind the existing gates. Application Insights data-plane queries stay out.",
    "Globals: --profile, --tenant, --subscription / -s, --management-group, --config, --fields, --full, --limit, --help / -h.",
    `Examples: az-axi ${path}${show ? " --ids <ARM-id> --full" : ""}`,
  ].join("\n");
}

export const MONITOR_READS_HELP = [
  "az-axi monitor metrics alert list|show",
  "az-axi monitor action-group list|show",
  "az-axi monitor diagnostic-settings list|show --resource <ARM-id>",
  "az-axi monitor metrics list --resource <ARM-id> [--metric <name>]",
  monitorLeafHelp("monitor metrics alert show"),
  monitorLeafHelp("monitor action-group show"),
  monitorLeafHelp("monitor diagnostic-settings show"),
  monitorLeafHelp("monitor metrics list"),
].join("\n");
