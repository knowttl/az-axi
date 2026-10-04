const SELECTORS: Record<string, string> = {
  "policy assignment list": "--resource-group / -g scopes the list to one resource group; --name / -n filters one exact assignment name.",
  "policy assignment show": "--name / -n in one subscription (add --resource-group / -g for resource-group scope), or --ids <assignment-ARM-id> alone.",
  "policy definition list": "Lists custom definitions in the selected subscriptions; built-in definitions arrive through the same subscription scope. --name / -n filters one exact definition name.",
  "policy definition show": "--name / -n in one subscription for a custom definition, or --ids <definition-ARM-id> alone (built-ins are tenant-scoped: show them with --ids).",
  "policy set-definition list": "Lists custom initiatives in the selected subscriptions; built-in initiatives arrive through the same subscription scope. --name / -n filters one exact initiative name.",
  "policy set-definition show": "--name / -n in one subscription for a custom initiative, or --ids <initiative-ARM-id> alone (built-ins are tenant-scoped: show them with --ids).",
  "policy state list": "--resource-group / -g scopes the query to one resource group; --name / -n filters one exact resource name; --assignment filters one exact assignment name; --compliance filters Compliant or NonCompliant states.",
}

const DETAIL: Record<string, string> = {
  "policy assignment list": "Rows default to name, scope, definition (the assigned policy or initiative) and enforcement (Default or DoNotEnforce). The effect (Audit, Deny, ...) lives on the definition: follow the definition hint for it.",
  "policy assignment show": "Show returns the display name, description, scope, assigned definition, enforcement mode, parameters and non-compliance messages.",
  "policy definition list": "Rows default to name, display, type (BuiltIn or Custom), effect (the policy rule's then-effect) and category.",
  "policy definition show": "Show returns the display name, description, mode, type, effect, category, version and the policy rule plus parameter definitions.",
  "policy set-definition list": "Rows default to name, display, type (BuiltIn or Custom), definitions (the member definition count) and category.",
  "policy set-definition show": "Show returns the display name, description, type, category and every member definition reference.",
  "policy state list": "Rows default to resource, assignment, compliance, definition and evaluation time, newest first, with byCompliance counts over every fetched state. The query is a reviewed bodyless read POST; scan triggers, summaries and remediations stay out of scope.",
}

const FIELDS: Record<string, string> = {
  "policy assignment list": "--fields: name, scope, definition, enforcement.",
  "policy assignment show": "--fields: name, id, display, description, scope, definition, enforcement, parameters, nonComplianceMessages, notScopes, metadata.",
  "policy definition list": "--fields: name, display, type, effect, category.",
  "policy definition show": "--fields: name, id, display, description, mode, type, effect, category, version, rule, parameters.",
  "policy set-definition list": "--fields: name, display, type, definitions, category.",
  "policy set-definition show": "--fields: name, id, display, description, type, category, definitions, parameters.",
  "policy state list": "--fields: resource, assignment, compliance, definition, time.",
}

export function governanceLeafHelp(path: string): string {
  const show = path.endsWith(" show");
  return [
    `Command: az-axi ${path}`,
    `az-axi ${path} ${SELECTORS[path] ?? ""}`.trimEnd(),
    "Read-only governance GETs against Microsoft.Authorization: assignments, definitions and initiatives use api-version 2021-06-01. Compliance states use the reviewed bodyless queryResults POST at api-version 2024-10-01. Management-group scope is unsupported; select subscriptions explicitly.",
    "Lists fan out across the selected subscriptions (flags, environment, profile, else all accessible) with exact --name / -n filtering. --limit defaults to 50; --full shows every fetched row. ARM lists follow up to 100 pages per subscription and compliance queries up to 10 service pages without imposing a query result limit; incomplete counts are disclosed as lower bounds.",
    "Show by name needs exactly one subscription; --ids takes exactly one ARM ID of the same collection and uses the ID's subscription when no scope is configured.",
    DETAIL[path] ?? "",
    "--fields selects listed fields and takes precedence over --full; --full expands safe metadata and shows every fetched row. No view returns secrets, keys or credential fields.",
    FIELDS[path] ?? "",
    "Assignment mutations are destructive under policy and stay blocked. Policy scans, summaries, exemptions and remediations stay out of scope.",
    "Globals: --profile, --tenant, --subscription / -s, --management-group, --config, --fields, --full, --limit, --help / -h.",
    `Examples: az-axi ${path}${show ? " --ids <ARM-id> --full" : ""}`,
  ].join("\n");
}

export const POLICY_HELP = [
  "az-axi policy assignment list|show",
  "az-axi policy definition list|show",
  "az-axi policy set-definition list|show",
  "az-axi policy state list",
  governanceLeafHelp("policy assignment show"),
].join("\n");
