const SELECTORS: Record<string, string> = {
  "role definition list": "--resource-group / -g scopes the list to one resource group; --name / -n matches one definition GUID or role name (e.g. Reader); --custom-role-only keeps custom roles.",
  "role definition show": "--name / -n takes the definition GUID in one subscription (add --resource-group / -g for resource-group scope), or --ids <definition-ARM-id> alone (built-ins are tenant-scoped: show them with --ids).",
};

const DETAIL: Record<string, string> = {
  "role definition list": "Rows default to name (the definition GUID), role (the display name), type (BuiltInRole or CustomRole), actions and dataActions, with byType counts. Control-plane and data-plane permission planes stay separately labelled.",
  "role definition show": "Show returns the role name, description, type, the four permission planes (actions, dataActions, notActions, notDataActions) kept separately labelled, assignable scopes and modification times. No native role-definition mutation commands are available; generic api writes to role definitions are destructive under policy and require the existing destructive confirmation.",
};

const FIELDS: Record<string, string> = {
  "role definition list": "--fields: name, role, type, actions, dataActions.",
  "role definition show": "--fields: name, id, role, description, type, actions, dataActions, notActions, notDataActions, assignableScopes, createdOn, updatedOn.",
};

export function roleLeafHelp(path: string): string {
  const show = path.endsWith(" show");
  return [
    `Command: az-axi ${path}`,
    `az-axi ${path} ${SELECTORS[path] ?? ""}`.trimEnd(),
    "Read-only role-definition GETs against Microsoft.Authorization at api-version 2022-04-01. The subscription list carries built-in definitions alongside customs. Management-group scope is unsupported; select subscriptions explicitly.",
    "Lists fan out across the selected subscriptions (flags, environment, profile, else all accessible) with exact --name / -n filtering. --limit defaults to 50; --full shows every fetched row. ARM lists follow up to 100 pages per subscription; incomplete counts are disclosed as lower bounds.",
    "Show by name needs exactly one subscription and takes the definition GUID; resolve a display name to its GUID with `role definition list` first. --ids takes exactly one role-definition ARM ID and uses the ID's subscription when one is present.",
    DETAIL[path] ?? "",
    "--fields selects listed fields and takes precedence over --full; --full expands safe metadata and shows every fetched row. No view returns secrets, keys or credential fields.",
    FIELDS[path] ?? "",
    "No native role-definition mutation commands are available; generic api writes to role definitions are destructive under policy and require the existing destructive confirmation. Role assignments stay on `rbac list` (alias `role assignment list`).",
    "Globals: --profile, --tenant, --subscription / -s, --management-group, --config, --fields, --full, --limit, --help / -h.",
    `Examples: az-axi ${path}${show ? " --ids <ARM-id> --full" : ""}`,
  ].join("\n");
}

export const ROLE_HELP = [
  "az-axi role definition list|show",
  roleLeafHelp("role definition show"),
].join("\n");
