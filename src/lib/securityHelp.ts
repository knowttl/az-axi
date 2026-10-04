const SELECTORS: Record<string, string> = {
  "security pricing list": "--name / -n filters one exact plan name (e.g. VirtualMachines).",
  "security pricing show": "--name / -n takes the plan name in one subscription, or --ids <pricing-ARM-id> alone (resource-scoped pricings need --ids).",
  "security sub-assessment list": "--assessment-name filters one parent assessment; --assessed-resource-id <ARM-id> keeps findings for one assessed resource; --name / -n filters one exact sub-assessment name.",
  "security sub-assessment show": "--assessment-name <assessment> plus --name / -n <finding> in one subscription (add --assessed-resource-id <ARM-id> for a resource-scoped finding), or --ids <sub-assessment-ARM-id> alone.",
};

const DETAIL: Record<string, string> = {
  "security pricing list": "Rows default to name (the plan), tier (Free or Standard), subPlan and coverage (resourcesCoverageStatus), with byTier counts.",
  "security pricing show": "Show returns the tier, subPlan, enablement and trial times, enforcement, coverage, deprecation, replacement plans and extensions with their enabled state.",
  "security sub-assessment list": "Rows default to name, assessment (the parent assessment), resource (the assessed resource), status (Healthy, Unhealthy or NotApplicable) and severity, worst severity first, with byStatus and bySeverity counts. The subscription list-all carries every parent assessment; additionalData arrives in the full view only.",
  "security sub-assessment show": "Show returns the display name, description, category, impact, remediation, assessed resource, status code, cause, severity and generation time. --full adds the vulnerability ID and additionalData.",
};

const FIELDS: Record<string, string> = {
  "security pricing list": "--fields: name, tier, subPlan, coverage.",
  "security pricing show": "--fields: name, id, tier, subPlan, enablement, freeTrial, enforce, coverage, deprecated, replacedBy, extensions.",
  "security sub-assessment list": "--fields: name, assessment, resource, status, severity.",
  "security sub-assessment show": "--fields: name, id, assessment, display, description, category, impact, remediation, resource, source, status, cause, severity, time, vulnId, additionalData.",
};

export function securityReadLeafHelp(path: string): string {
  const show = path.endsWith(" show");
  return [
    `Command: az-axi ${path}`,
    `az-axi ${path} ${SELECTORS[path] ?? ""}`.trimEnd(),
    "Read-only Defender for Cloud GETs against Microsoft.Security: pricings use api-version 2024-01-01; sub-assessments use api-version 2019-01-01-preview (the only version). Management-group scope is unsupported; select subscriptions explicitly.",
    "Lists fan out across the selected subscriptions (flags, environment, profile, else all accessible) with exact --name / -n filtering. --limit defaults to 50; --full shows every fetched row. ARM lists follow up to 100 pages per subscription; incomplete counts are disclosed as lower bounds.",
    "Show by name needs exactly one subscription. --ids takes exactly one ARM ID of the same collection and uses the ID's subscription when one is present.",
    DETAIL[path] ?? "",
    "--fields selects listed fields and takes precedence over --full; --full expands safe metadata and shows every fetched row. No view returns secrets, keys or credential fields.",
    FIELDS[path] ?? "",
    "No native Defender plan or assessment mutation commands are available (`security pricing create` stays out); plan changes stay on generic api writes behind the existing gates. Alert status updates stay on `security alert update`. Assessment summaries stay on `defender assessments`.",
    "Globals: --profile, --tenant, --subscription / -s, --management-group, --config, --fields, --full, --limit, --help / -h.",
    `Examples: az-axi ${path}${show ? " --ids <ARM-id> --full" : ""}`,
  ].join("\n");
}

export const SECURITY_READS_HELP = [
  "az-axi security pricing list|show",
  "az-axi security sub-assessment list|show",
  securityReadLeafHelp("security pricing show"),
  securityReadLeafHelp("security sub-assessment show"),
].join("\n");
