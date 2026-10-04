import { DENY_ASSIGNMENTS } from "../lib/apiVersions.js";
import { assertKnownFlags, parseArgs } from "../lib/args.js";
import { profileFromArgs } from "../lib/context.js";
import {
  arrOf,
  governanceInvalid,
  objOf,
  runGovernanceList,
  runGovernanceShow,
  shortScope,
  str,
  type AnyObj,
  type GovernanceCollection,
} from "../lib/governance.js";
import { truncate } from "../lib/format.js";
import { governanceLeafHelp } from "../lib/governanceHelp.js";
import { commandFlags, commandMeta } from "../lib/registry.js";

export const meta = commandMeta("deny-assignment");

const CELL_TRUNCATE = 200;

function joined(values: Array<string | number>, full: boolean): string {
  const text = values.map(String).filter(Boolean).join(", ");
  return full ? text : truncate(text, CELL_TRUNCATE).text;
}

function permissionStrings(permissions: AnyObj[], keys: string[]): string[] {
  return permissions.flatMap((permission) =>
    keys.flatMap((key) => (Array.isArray(permission[key]) ? permission[key].map(String) : []))).filter(Boolean);
}

function scopeKind(scope: string): string {
  if (/^\/subscriptions\/[^/]+$/i.test(scope)) return "subscription";
  if (/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+$/i.test(scope)) return "resourceGroup";
  return scope ? "resource" : "(unknown)";
}

const DENIES: GovernanceCollection = {
  words: [],
  top: "deny-assignment",
  noun: "deny assignments",
  arm: "denyAssignments",
  apiVersion: DENY_ASSIGNMENTS,
  idTail: /^\/subscriptions\/[^/]+(\/.*)?\/providers\/Microsoft\.Authorization\/denyAssignments\/[^/]+$/i,
  listTargets: (subscription, group) => [
    {
      method: "GET",
      path: `/subscriptions/${subscription}${group ? `/resourceGroups/${group}` : ""}/providers/Microsoft.Authorization/denyAssignments`,
      apiVersion: DENY_ASSIGNMENTS,
    },
  ],
  compact: (item, full) => {
    const props = objOf(item.properties);
    const permissions = arrOf(props.permissions);
    return {
      name: item.name,
      scope: full ? str(props.scope) : shortScope(str(props.scope)),
      actions: joined(permissionStrings(permissions, ["actions", "dataActions"]), full),
    };
  },
  fields: ["name", "scope", "actions"],
  detail: (item, full, _limit) => {
    const props = objOf(item.properties);
    const permissions = arrOf(props.permissions);
    const actions = permissionStrings(permissions, ["actions", "dataActions"]);
    const excluded = permissionStrings(permissions, ["notActions", "notDataActions"]);
    const principals = arrOf(props.principals).map((principal) => str(principal.id) || str(principal.displayName));
    return {
      body: {
        name: item.name,
        id: item.id,
        scope: str(props.scope),
        description: full ? str(props.description) : truncate(str(props.description), CELL_TRUNCATE).text,
        actions: full ? actions : [joined(actions, full)],
        excluded: full ? excluded : [joined(excluded, full)],
        principals: full ? principals : [joined(principals, full)],
        totalPrincipals: principals.length,
        doNotApplyToChildScopes: props.doNotApplyToChildScopes ?? "",
        systemProtected: props.isSystemProtected ?? "",
      },
    };
  },
  aggregate: (items) => {
    const byScopeKind: Record<string, number> = {};
    for (const item of items) {
      const kind = scopeKind(str(objOf(item.properties).scope));
      byScopeKind[kind] = (byScopeKind[kind] ?? 0) + 1;
    }
    return { byScopeKind };
  },
};

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const verb = args.positionals[0];
  const path = `deny-assignment ${verb}`;
  if (verb !== "list" && verb !== "show") {
    governanceInvalid("expected deny-assignment list|show", path);
  }
  if (args.positionals.length !== 1) {
    governanceInvalid(`unexpected argument \`${args.positionals[1]}\` for \`${path}\``, path);
  }
  assertKnownFlags(args, commandFlags(path), path, governanceLeafHelp(path));
  const profile = profileFromArgs(args);
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
    governanceInvalid("management-group scope is unsupported for deny-assignment reads; select subscriptions explicitly", path);
  }
  if (verb === "list") return runGovernanceList(profile, args, DENIES, path);
  return runGovernanceShow(profile, args, DENIES, path, (subscription, group, name) =>
    `/subscriptions/${subscription}${group ? `/resourceGroups/${group}` : ""}/providers/Microsoft.Authorization/denyAssignments/${name}`);
}
