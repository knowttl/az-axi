import { AxiError } from "axi-sdk-js";
import { DEFENDER_ALERTS, DEFENDER_PRICINGS, DEFENDER_SUB_ASSESSMENTS } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagText, parseArgs, type ParsedArgs } from "../lib/args.js";
import { buildUrl } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import { subscriptions } from "../lib/discovery.js";
import { dryRun } from "../lib/dryRun.js";
import { executeWrite } from "../lib/execute.js";
import { enforceGates } from "../lib/gates.js";
import { shortDate, truncate } from "../lib/format.js";
import {
  arrOf,
  governanceInvalid,
  governanceSegment,
  objOf,
  runGovernanceList,
  runGovernanceShow,
  str,
  strArr,
  tailName,
  type AnyObj,
  type GovernanceCollection,
  type GovernanceItem,
} from "../lib/governance.js";
import { parseTimeoutFlag } from "../lib/lro.js";
import { assertReadOnlyBoundary, classifyRequest } from "../lib/policy.js";
import { commandFlags, commandMeta, runWithEffect } from "../lib/registry.js";
import { securityReadLeafHelp } from "../lib/securityHelp.js";
import { formatFlagValue } from "../lib/shell.js";

export const meta = commandMeta("security");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: Record<string, string> = { dismiss: "Dismissed", resolve: "Resolved", activate: "Active" };
const PROTECTION = "Defender alert actions do not document ETag/If-Match protection; no concurrency guarantee";
const CELL_TRUNCATE = 200;

/** Worst first, so grouped output answers triage questions without a second call. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function invalid(message: string, path: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", [securityReadLeafHelp(path)]);
}

function joined(values: Array<string | number>, full: boolean): string {
  const text = values.map(String).filter(Boolean).join(", ");
  return full ? text : truncate(text, CELL_TRUNCATE).text;
}

/** Parent assessment name from a sub-assessment ARM ID (`.../assessments/{name}/subAssessments/...`). */
function parentAssessment(id: string): string {
  return /\/assessments\/([^/]+)\/subassessments\//i.exec(id)?.[1] ?? "(unknown)";
}

function subSeverity(item: GovernanceItem): string {
  return str(objOf(objOf(item.properties).status).severity);
}

const PRICING: GovernanceCollection = {
  words: ["pricing"],
  top: "security",
  noun: "Defender plans",
  arm: "pricings",
  apiVersion: DEFENDER_PRICINGS,
  idTail: /^\/subscriptions\/[^/]+(\/.*)?\/providers\/Microsoft\.Security\/pricings\/[^/]+$/i,
  listTargets: (subscription) => [
    { method: "GET", path: `/subscriptions/${subscription}/providers/Microsoft.Security/pricings`, apiVersion: DEFENDER_PRICINGS },
  ],
  compact: (item, full) => {
    const props = objOf(item.properties);
    return {
      name: item.name,
      tier: str(props.pricingTier),
      subPlan: full ? str(props.subPlan) : truncate(str(props.subPlan), CELL_TRUNCATE).text,
      coverage: str(props.resourcesCoverageStatus),
    };
  },
  fields: ["name", "tier", "subPlan", "coverage"],
  detail: (item, full, _limit) => {
    const props = objOf(item.properties);
    const extensions = arrOf(props.extensions);
    const summary = (entry: AnyObj): string => {
      const enabled = str(entry.isEnabled);
      return enabled ? `${str(entry.name)} (${enabled})` : str(entry.name);
    };
    return {
      body: {
        name: item.name,
        id: item.id,
        tier: str(props.pricingTier),
        subPlan: str(props.subPlan),
        enablement: shortDate(str(props.enablementTime)),
        freeTrial: str(props.freeTrialRemainingTime),
        enforce: props.enforce ?? "",
        coverage: str(props.resourcesCoverageStatus),
        deprecated: props.deprecated ?? "",
        replacedBy: strArr(props.replacedBy),
        extensions: full
          ? extensions.map((entry) => ({
            name: str(entry.name),
            enabled: str(entry.isEnabled),
            ...(entry.additionalExtensionProperties === undefined
              ? {}
              : { properties: entry.additionalExtensionProperties }),
          }))
          : [joined(extensions.map(summary), full)],
      },
    };
  },
  aggregate: (items) => {
    const byTier: Record<string, number> = {};
    for (const item of items) {
      const tier = str(objOf(item.properties).pricingTier) || "(unknown)";
      byTier[tier] = (byTier[tier] ?? 0) + 1;
    }
    return { byTier };
  },
};

const SUB_ASSESSMENT: GovernanceCollection = {
  words: ["sub-assessment"],
  top: "security",
  noun: "security sub-assessments",
  arm: "subAssessments",
  apiVersion: DEFENDER_SUB_ASSESSMENTS,
  idTail: /^\/subscriptions\/[^/]+(\/.*)?\/providers\/Microsoft\.Security\/assessments\/[^/]+\/subAssessments\/[^/]+$/i,
  listTargets: (subscription) => [
    { method: "GET", path: `/subscriptions/${subscription}/providers/Microsoft.Security/subAssessments`, apiVersion: DEFENDER_SUB_ASSESSMENTS },
  ],
  compare: (a, b) =>
    (SEVERITY_RANK[subSeverity(a).toLowerCase()] ?? 4) - (SEVERITY_RANK[subSeverity(b).toLowerCase()] ?? 4) ||
    str(objOf(b.properties).timeGenerated).localeCompare(str(objOf(a.properties).timeGenerated)),
  compact: (item, full) => {
    const props = objOf(item.properties);
    const status = objOf(props.status);
    const resource = str(objOf(props.resourceDetails).id);
    return {
      name: item.name,
      assessment: parentAssessment(item.id),
      resource: full ? resource : tailName(resource),
      status: str(status.code),
      severity: str(status.severity),
    };
  },
  fields: ["name", "assessment", "resource", "status", "severity"],
  detail: (item, full, _limit) => {
    const props = objOf(item.properties);
    const status = objOf(props.status);
    const resourceDetails = objOf(props.resourceDetails);
    const display = str(props.displayName);
    const description = str(props.description);
    const impact = str(props.impact);
    const remediation = str(props.remediation);
    return {
      body: {
        name: item.name,
        id: item.id,
        assessment: parentAssessment(item.id),
        display: full ? display : truncate(display, CELL_TRUNCATE).text,
        description: full ? description : truncate(description, CELL_TRUNCATE).text,
        category: str(props.category),
        impact: full ? impact : truncate(impact, CELL_TRUNCATE).text,
        remediation: full ? remediation : truncate(remediation, CELL_TRUNCATE).text,
        resource: str(resourceDetails.id),
        source: str(resourceDetails.source),
        status: str(status.code),
        cause: str(status.cause),
        severity: str(status.severity),
        time: shortDate(str(props.timeGenerated)),
        ...(full ? { vulnId: str(props.id), additionalData: objOf(props.additionalData) } : {}),
      },
    };
  },
  aggregate: (items) => {
    const byStatus: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const item of items) {
      const status = objOf(objOf(item.properties).status);
      const code = str(status.code) || "(unknown)";
      const severity = str(status.severity) || "(unknown)";
      byStatus[code] = (byStatus[code] ?? 0) + 1;
      bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    }
    return { byStatus, bySeverity };
  },
  extraListFilter: (item, args) => {
    const assessment = args.flags["assessment-name"];
    if (typeof assessment === "string" && parentAssessment(item.id).toLowerCase() !== assessment.toLowerCase()) return false;
    const assessed = args.flags["assessed-resource-id"];
    if (typeof assessed === "string") {
      const prefix = assessed.toLowerCase();
      const resource = str(objOf(objOf(item.properties).resourceDetails).id).toLowerCase();
      if (!item.id.toLowerCase().startsWith(prefix) && resource !== prefix) return false;
    }
    return true;
  },
};

const READ_COLLECTIONS: GovernanceCollection[] = [PRICING, SUB_ASSESSMENT];

function segment(value: string | undefined, flag: string): string {
  if (!value || /[/\\%?#,]/.test(value) || value === "." || value === "..") {
    throw new AxiError(`--${flag} must name one resource path segment`, "VALIDATION_ERROR", [
      `Pass --${flag} <name> from the alert resource ID`,
    ]);
  }
  return encodeURIComponent(value);
}

async function runAlertUpdate(args: ParsedArgs): Promise<Record<string, unknown>> {
  assertKnownFlags(args, commandFlags("security alert update"), "security alert update");
  if (args.positionals.join(" ") !== "alert update") {
    throw new AxiError("expected `security alert update` with no positional arguments", "VALIDATION_ERROR", [
      "Run `az-axi security alert update --help`",
    ]);
  }
  const location = segment(flagText(args, "location"), "location");
  const name = segment(flagText(args, "name"), "name");
  const group = flagText(args, "resource-group");
  const rgPath = group === undefined ? "" : `/resourceGroups/${segment(group, "resource-group")}`;
  const action = flagText(args, "status")?.toLowerCase();
  if (!action || !Object.hasOwn(STATUSES, action)) {
    throw new AxiError("--status must be dismiss, resolve or activate", "VALIDATION_ERROR", [
      "Run `az-axi security alert update --help`",
    ]);
  }
  if (flagText(args, "management-group")) {
    throw new AxiError("alert updates require one subscription, not a management group", "VALIDATION_ERROR", [
      "Pass --subscription <id>",
    ]);
  }
  const ifMatch = flagText(args, "if-match");
  const timeoutMs = parseTimeoutFlag(flagText(args, "timeout"));
  const subscriptions = flagList(args, "subscription");
  if (subscriptions?.length !== 1 || !GUID.test(subscriptions[0]!)) {
    throw new AxiError("alert updates require exactly one explicit subscription ID", "VALIDATION_ERROR", [
      "Pass --subscription <id> from `az-axi sub list`; names and batches are not supported",
    ]);
  }
  const subscription = subscriptions[0]!;
  const profile = profileFromArgs(args);
  const path = `/subscriptions/${subscription}${rgPath}/providers/Microsoft.Security/locations/${location}/alerts/${name}/${action}`;
  const shape = { resource: "arm" as const, method: "POST", path };
  const cls = classifyRequest(shape);
  assertReadOnlyBoundary(shape, cls);
  const execute = enforceGates(profile, shape, cls, { execute: flagBool(args, "execute") });
  const selectors = ["profile", "tenant", "config"]
    .map((key) => flagText(args, key) === undefined ? "" : formatFlagValue(key, flagText(args, key)!))
    .filter(Boolean).join(" ");
  const desiredState = { properties: { status: STATUSES[action] } };
  if (execute) {
    return executeWrite({ profile, method: "POST", path: buildUrl({ path, apiVersion: DEFENDER_ALERTS }),
      cls: "write", body: undefined, desiredState, protection: PROTECTION, ifMatch,
      selectors, timeoutMs, noWait: flagBool(args, "no-wait") });
  }
  const preview = await dryRun({ profile, resource: "arm", method: "POST", path, cls,
    body: undefined, desiredState, apiVersion: DEFENDER_ALERTS, ifMatch, selectors });
  const command = ["az-axi security alert update", selectors, formatFlagValue("subscription", subscription),
    formatFlagValue("location", flagText(args, "location")!), formatFlagValue("name", flagText(args, "name")!),
    formatFlagValue("status", action), ...(group === undefined ? [] : [formatFlagValue("resource-group", group)]),
    ...(ifMatch === undefined ? [] : [formatFlagValue("if-match", ifMatch)]),
    ...(flagText(args, "timeout") === undefined ? [] : [formatFlagValue("timeout", flagText(args, "timeout")!)]),
    ...(flagBool(args, "no-wait") ? ["--no-wait"] : []), "--execute"].filter(Boolean).join(" ");
  return { ...preview, protection: PROTECTION, help: [`\`${command}\``] };
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  // The alert update is the one write verb in this read-effect module; it
  // elevates to the write effect for its own requests only (sentinel pattern).
  if (args.positionals[0] === "alert") {
    return runWithEffect("write", () => runAlertUpdate(args));
  }
  const words = args.positionals.slice(0, -1);
  const verb = args.positionals[args.positionals.length - 1];
  const path = `security ${words.join(" ")} ${verb}`;
  const collection = READ_COLLECTIONS.find((candidate) =>
    candidate.words.length === words.length && candidate.words.every((word, index) => words[index] === word));
  if (!collection || (verb !== "list" && verb !== "show")) {
    invalid("expected security pricing|sub-assessment list|show, or security alert update", path);
  }
  if (args.positionals.length !== words.length + 1) {
    invalid(`unexpected argument \`${args.positionals[words.length + 1]}\` for \`${path}\``, path);
  }
  assertKnownFlags(args, commandFlags(path), path, securityReadLeafHelp(path));
  const profile = profileFromArgs(args);
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
    governanceInvalid("management-group scope is unsupported for Defender reads; select subscriptions explicitly", path);
  }
  const assessed = args.flags["assessed-resource-id"];
  if (typeof assessed === "string") {
    const scopeSub = /^\/subscriptions\/([^/]+)/i.exec(assessed.trim())?.[1];
    if (!scopeSub || !GUID.test(scopeSub)) {
      governanceInvalid("--assessed-resource-id must be an ARM ID under /subscriptions/<id>", path);
    }
    const selected = await subscriptions(profile);
    if (!selected.some((id) => id.toLowerCase() === scopeSub.toLowerCase())) {
      governanceInvalid("--assessed-resource-id conflicts with selected subscriptions", path);
    }
  }
  if (verb === "list") return runGovernanceList(profile, args, collection, path);
  if (collection === PRICING) {
    return runGovernanceShow(profile, args, collection, path, (subscription, _group, name) =>
      `/subscriptions/${subscription}/providers/Microsoft.Security/pricings/${name}`);
  }
  return runGovernanceShow(profile, args, collection, path, (subscription, _group, name) => {
    const assessment = args.flags["assessment-name"];
    if (typeof assessment !== "string" || !assessment.trim()) {
      governanceInvalid("security sub-assessment show by name needs --assessment-name <assessment>", path);
    }
    const scope = typeof assessed === "string" && assessed.trim()
      ? assessed.trim()
      : `/subscriptions/${subscription}`;
    return `${scope}/providers/Microsoft.Security/assessments/` +
      `${governanceSegment(assessment.trim(), "assessment-name", path)}/subAssessments/${name}`;
  });
}
