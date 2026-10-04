import { POLICY, POLICY_STATES } from "../lib/apiVersions.js";
import { assertKnownFlags, parseArgs } from "../lib/args.js";
import { profileFromArgs } from "../lib/context.js";
import {
  arrOf,
  fetchStatePages,
  governanceInvalid,
  objOf,
  runGovernanceList,
  runGovernanceShow,
  selectorSuffix,
  shortScope,
  str,
  strArr,
  tailName,
  type GovernanceCollection,
} from "../lib/governance.js";
import { governanceLeafHelp } from "../lib/governanceHelp.js";
import { shortDate, truncate } from "../lib/format.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { formatFlagValue } from "../lib/shell.js";

export const meta = commandMeta("policy");

const CELL_TRUNCATE = 200;

function assignmentScope(subscription: string, group: string | undefined): string {
  return `/subscriptions/${subscription}${group ? `/resourceGroups/${group}` : ""}`;
}

const ASSIGNMENT: GovernanceCollection = {
  words: ["assignment"],
  top: "policy",
  noun: "policy assignments",
  arm: "policyAssignments",
  apiVersion: POLICY,
  idTail: /^\/subscriptions\/[^/]+\/(resourceGroups\/[^/]+\/)?providers\/Microsoft\.Authorization\/policyAssignments\/[^/]+$/i,
  listTargets: (subscription, group) => [
    { method: "GET", path: `${assignmentScope(subscription, group)}/providers/Microsoft.Authorization/policyAssignments`, apiVersion: POLICY },
  ],
  compact: (item, full) => {
    const props = objOf(item.properties);
    return {
      name: item.name,
      scope: shortScope(str(props.scope)),
      definition: full ? str(props.policyDefinitionId) : tailName(str(props.policyDefinitionId)),
      enforcement: str(props.enforcementMode) || "Default",
    };
  },
  fields: ["name", "scope", "definition", "enforcement"],
  detail: (item, full, _limit) => {
    const props = objOf(item.properties);
    const description = str(props.description);
    const parameters = JSON.stringify(props.parameters ?? {});
    return {
      body: {
        name: item.name,
        id: item.id,
        display: str(props.displayName),
        description: full ? description : truncate(description, CELL_TRUNCATE).text,
        scope: str(props.scope),
        definition: full ? str(props.policyDefinitionId) : tailName(str(props.policyDefinitionId)),
        enforcement: str(props.enforcementMode) || "Default",
        parameters: full ? parameters : truncate(parameters, CELL_TRUNCATE).text,
        nonComplianceMessages: arrOf(props.nonComplianceMessages).map((message) => {
          const text = str(message.message);
          return full ? text : truncate(text, CELL_TRUNCATE).text;
        }),
        ...(full ? { notScopes: strArr(props.notScopes), metadata: objOf(props.metadata) } : {}),
      },
    };
  },
  aggregate: (items) => {
    const byEnforcement: Record<string, number> = {};
    for (const item of items) {
      const mode = str(objOf(item.properties).enforcementMode) || "Default";
      byEnforcement[mode] = (byEnforcement[mode] ?? 0) + 1;
    }
    return { byEnforcement };
  },
  followHint: (first, args) => {
    const definitionId = str(objOf(first.properties).policyDefinitionId);
    const collection = [DEFINITION, SET_DEFINITION].find((candidate) => candidate.idTail.test(definitionId));
    if (!collection) return undefined;
    return `Run \`az-axi policy ${collection.words[0]} show ${formatFlagValue("ids", definitionId)}${selectorSuffix(args, ["profile", "config", "tenant"])}` +
      `\` for the assigned definition`;
  },
};

function definitionCollection(kind: "definition" | "set-definition"): GovernanceCollection {
  const isSet = kind === "set-definition";
  const arm = isSet ? "policySetDefinitions" : "policyDefinitions";
  const noun = isSet ? "policy initiatives" : "policy definitions";
  const singular = isSet ? "policy initiative" : "policy definition";
  return {
    words: [kind],
    top: "policy",
    noun,
    arm,
    apiVersion: POLICY,
    idTail: new RegExp(`^(\\/subscriptions\\/[^/]+)?\\/providers\\/Microsoft\\.Authorization\\/${arm}\\/[^/]+$`, "i"),
    listTargets: (subscription) => [
      { method: "GET", path: `/subscriptions/${subscription}/providers/Microsoft.Authorization/${arm}`, apiVersion: POLICY },
    ],
    compact: (item, full) => {
      const props = objOf(item.properties);
      const display = str(props.displayName);
      const base = {
        name: item.name,
        display: full ? display : truncate(display, CELL_TRUNCATE).text,
        type: str(props.policyType),
        category: str(objOf(props.metadata).category),
      };
      return isSet
        ? { ...base, definitions: arrOf(props.policyDefinitions).length }
        : { ...base, effect: str(objOf(objOf(props.policyRule).then).effect) };
    },
    fields: isSet ? ["name", "display", "type", "definitions", "category"] : ["name", "display", "type", "effect", "category"],
    detail: (item, full, _limit) => {
      const props = objOf(item.properties);
      const description = str(props.description);
      const parameters = JSON.stringify(props.parameters ?? {});
      const members = arrOf(props.policyDefinitions);
      return {
        body: {
          name: item.name,
          id: item.id,
          display: str(props.displayName),
          description: full ? description : truncate(description, CELL_TRUNCATE).text,
          ...(isSet ? {} : { mode: str(props.mode), effect: str(objOf(objOf(props.policyRule).then).effect) }),
          type: str(props.policyType),
          category: str(objOf(props.metadata).category),
          ...(isSet ? {} : { version: str(props.version) }),
          ...(isSet
            ? { definitions: full ? members : members.map((member) => tailName(str(member.policyDefinitionId))) }
            : { rule: full ? JSON.stringify(props.policyRule ?? {}) : truncate(JSON.stringify(props.policyRule ?? {}), CELL_TRUNCATE).text }),
          parameters: full ? parameters : truncate(parameters, CELL_TRUNCATE).text,
        },
      };
    },
    aggregate: (items) => {
      const byType: Record<string, number> = {};
      for (const item of items) {
        const type = str(objOf(item.properties).policyType) || "(unknown)";
        byType[type] = (byType[type] ?? 0) + 1;
      }
      return { byType };
    },
  };
}

const DEFINITION = definitionCollection("definition");
const SET_DEFINITION = definitionCollection("set-definition");

const STATES: GovernanceCollection = {
  words: ["state"],
  top: "policy",
  noun: "policy states",
  arm: "policyStates",
  apiVersion: POLICY_STATES,
  idTail: /\/providers\/Microsoft\.PolicyInsights\/policyStates\/[^/]+$/i,
  listTargets: (subscription, group) => [
    {
      method: "POST",
      path: `${assignmentScope(subscription, group)}/providers/Microsoft.PolicyInsights/policyStates/latest/queryResults`,
      apiVersion: POLICY_STATES,
    },
  ],
  fetchTargets: fetchStatePages,
  matchName: (item, name) => tailName(str(item.resourceId)).toLowerCase() === name.toLowerCase(),
  compare: (a, b) => str(b.timestamp).localeCompare(str(a.timestamp)),
  compact: (item, full) => ({
    resource: full ? str(item.resourceId) : tailName(str(item.resourceId)),
    assignment: full ? str(item.policyAssignmentId) : tailName(str(item.policyAssignmentId)),
    compliance: str(item.complianceState),
    definition: full ? str(item.policyDefinitionId) : tailName(str(item.policyDefinitionId)),
    time: shortDate(str(item.timestamp)),
  }),
  fields: ["resource", "assignment", "compliance", "definition", "time"],
  detail: (item, _full, _limit) => ({ body: { ...item } }),
  aggregate: (items) => {
    const byCompliance: Record<string, number> = {};
    for (const item of items) {
      const state = str(item.complianceState) || "(unknown)";
      byCompliance[state] = (byCompliance[state] ?? 0) + 1;
    }
    return { byCompliance };
  },
  followHint: (first, args) => {
    const assignmentId = str(first.policyAssignmentId);
    if (!ASSIGNMENT.idTail.test(assignmentId)) return undefined;
    return `Run \`az-axi policy assignment show ${formatFlagValue("ids", assignmentId)}${selectorSuffix(args, ["profile", "config", "tenant"])}` +
      `\` for the assigned policy`;
  },
  extraListFilter: (item, args) => {
    const assignment = args.flags["assignment"];
    if (typeof assignment === "string" && tailName(str(item.policyAssignmentId)).toLowerCase() !== assignment.toLowerCase()) return false;
    const compliance = args.flags["compliance"];
    if (typeof compliance === "string" && str(item.complianceState).toLowerCase() !== compliance.toLowerCase()) return false;
    return true;
  },
};

const COLLECTIONS: GovernanceCollection[] = [ASSIGNMENT, DEFINITION, SET_DEFINITION, STATES];

function collectionFor(words: string[], path: string): GovernanceCollection {
  const found = COLLECTIONS.find((collection) =>
    collection.words.length === words.length && collection.words.every((word, index) => words[index] === word));
  if (!found) {
    governanceInvalid("expected policy assignment|definition|set-definition list|show, or policy state list", path);
  }
  return found;
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const positionalWords = args.positionals.slice(0, 2);
  const verb = positionalWords[positionalWords.length - 1];
  const words = positionalWords.slice(0, -1);
  const path = `policy ${words.join(" ")} ${verb}`;
  const collection = collectionFor(words, path);
  if (verb !== "list" && verb !== "show") {
    governanceInvalid("expected policy assignment|definition|set-definition list|show, or policy state list", path);
  }
  if (words.join(" ") === "state" && verb === "show") {
    governanceInvalid("policy state has no show view: list compliance states with `policy state list`", path);
  }
  if (args.positionals.length !== words.length + 1) {
    governanceInvalid(`unexpected argument \`${args.positionals[words.length + 1]}\` for \`${path}\``, path);
  }
  assertKnownFlags(args, commandFlags(path), path, governanceLeafHelp(path));
  const profile = profileFromArgs(args);
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
    governanceInvalid("management-group scope is unsupported for policy reads; select subscriptions explicitly", path);
  }
  if (verb === "list") return runGovernanceList(profile, args, collection, path);
  return runGovernanceShow(profile, args, collection, path, (subscription, group, name) => {
    if (words.join(" ") === "assignment") {
      return `${assignmentScope(subscription, group)}/providers/Microsoft.Authorization/policyAssignments/${name}`;
    }
    const arm = words.join(" ") === "set-definition" ? "policySetDefinitions" : "policyDefinitions";
    return `/subscriptions/${subscription}/providers/Microsoft.Authorization/${arm}/${name}`;
  });
}
