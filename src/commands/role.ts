import { ROLE_DEFINITIONS } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, parseArgs } from "../lib/args.js";
import { profileFromArgs } from "../lib/context.js";
import {
  arrOf,
  governanceInvalid,
  objOf,
  runGovernanceList,
  runGovernanceShow,
  str,
  strArr,
  type AnyObj,
  type GovernanceCollection,
} from "../lib/governance.js";
import { truncate } from "../lib/format.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { roleLeafHelp } from "../lib/roleHelp.js";

export const meta = commandMeta("role");

const CELL_TRUNCATE = 200;

function joined(values: Array<string | number>, full: boolean): string {
  const text = values.map(String).filter(Boolean).join(", ");
  return full ? text : truncate(text, CELL_TRUNCATE).text;
}

function permissionStrings(permissions: AnyObj[], key: string): string[] {
  return permissions.flatMap((permission) =>
    Array.isArray(permission[key]) ? permission[key].map(String) : []).filter(Boolean);
}

const ROLE_DEFINITION: GovernanceCollection = {
  words: ["definition"],
  top: "role",
  noun: "role definitions",
  arm: "roleDefinitions",
  apiVersion: ROLE_DEFINITIONS,
  idTail: /^(\/subscriptions\/[^/]+)?\/providers\/Microsoft\.Authorization\/roleDefinitions\/[^/]+$/i,
  listTargets: (subscription, group) => [
    {
      method: "GET",
      path: `/subscriptions/${subscription}${group ? `/resourceGroups/${group}` : ""}/providers/Microsoft.Authorization/roleDefinitions`,
      apiVersion: ROLE_DEFINITIONS,
    },
  ],
  // az matches --name against the GUID or the roleName (e.g. `Reader`).
  matchName: (item, name) =>
    item.name.toLowerCase() === name.toLowerCase() ||
    str(objOf(item.properties).roleName).toLowerCase() === name.toLowerCase(),
  compact: (item, full) => {
    const props = objOf(item.properties);
    const permissions = arrOf(props.permissions);
    return {
      name: item.name,
      role: full ? str(props.roleName) : truncate(str(props.roleName), CELL_TRUNCATE).text,
      type: str(props.type),
      actions: joined(permissionStrings(permissions, "actions"), full),
      dataActions: joined(permissionStrings(permissions, "dataActions"), full),
    };
  },
  fields: ["name", "role", "type", "actions", "dataActions"],
  detail: (item, full, _limit) => {
    const props = objOf(item.properties);
    const permissions = arrOf(props.permissions);
    const actions = permissionStrings(permissions, "actions");
    const dataActions = permissionStrings(permissions, "dataActions");
    const notActions = permissionStrings(permissions, "notActions");
    const notDataActions = permissionStrings(permissions, "notDataActions");
    const description = str(props.description);
    return {
      body: {
        name: item.name,
        id: item.id,
        role: str(props.roleName),
        description: full ? description : truncate(description, CELL_TRUNCATE).text,
        type: str(props.type),
        actions: full ? actions : [joined(actions, full)],
        dataActions: full ? dataActions : [joined(dataActions, full)],
        notActions: full ? notActions : [joined(notActions, full)],
        notDataActions: full ? notDataActions : [joined(notDataActions, full)],
        assignableScopes: full ? strArr(props.assignableScopes) : [joined(strArr(props.assignableScopes), full)],
        ...(full
          ? { createdOn: str(props.createdOn), updatedOn: str(props.updatedOn) }
          : {}),
      },
    };
  },
  aggregate: (items) => {
    const byType: Record<string, number> = {};
    for (const item of items) {
      const type = str(objOf(item.properties).type) || "(unknown)";
      byType[type] = (byType[type] ?? 0) + 1;
    }
    return { byType };
  },
  extraListFilter: (item, args) =>
    !flagBool(args, "custom-role-only") || str(objOf(item.properties).type).toLowerCase() === "customrole",
};

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const verb = args.positionals[1];
  const path = `role ${args.positionals[0]} ${verb}`;
  if (args.positionals[0] !== "definition" || (verb !== "list" && verb !== "show")) {
    governanceInvalid("expected role definition list|show", path);
  }
  if (args.positionals.length !== 2) {
    governanceInvalid(`unexpected argument \`${args.positionals[2]}\` for \`${path}\``, path);
  }
  assertKnownFlags(args, commandFlags(path), path, roleLeafHelp(path));
  const profile = profileFromArgs(args);
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
    governanceInvalid("management-group scope is unsupported for role reads; select subscriptions explicitly", path);
  }
  if (verb === "list") return runGovernanceList(profile, args, ROLE_DEFINITION, path);
  return runGovernanceShow(profile, args, ROLE_DEFINITION, path, (subscription, group, name) =>
    `/subscriptions/${subscription}${group ? `/resourceGroups/${group}` : ""}/providers/Microsoft.Authorization/roleDefinitions/${name}`);
}
