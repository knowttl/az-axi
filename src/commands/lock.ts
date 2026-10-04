import { MANAGEMENT_LOCKS } from "../lib/apiVersions.js";
import { assertKnownFlags, parseArgs } from "../lib/args.js";
import { profileFromArgs } from "../lib/context.js";
import {
  governanceInvalid,
  objOf,
  runGovernanceList,
  runGovernanceShow,
  shortScope,
  str,
  type GovernanceCollection,
} from "../lib/governance.js";
import { truncate } from "../lib/format.js";
import { governanceLeafHelp } from "../lib/governanceHelp.js";
import { commandFlags, commandMeta } from "../lib/registry.js";

export const meta = commandMeta("lock");

const CELL_TRUNCATE = 200;

/** The locked scope: the lock ARM ID without its `/providers/.../locks/{name}` tail. */
function lockScope(id: string): string {
  return id.replace(/\/providers\/Microsoft\.Authorization\/locks\/[^/]+$/i, "");
}

function joined(values: Array<string | number>, full: boolean): string {
  const text = values.map(String).filter(Boolean).join(", ");
  return full ? text : truncate(text, CELL_TRUNCATE).text;
}

const LOCKS: GovernanceCollection = {
  words: [],
  top: "lock",
  noun: "management locks",
  arm: "locks",
  apiVersion: MANAGEMENT_LOCKS,
  idTail: /^\/subscriptions\/[^/]+(\/.*)?\/providers\/Microsoft\.Authorization\/locks\/[^/]+$/i,
  listTargets: (subscription, group) => [
    {
      method: "GET",
      path: `/subscriptions/${subscription}${group ? `/resourceGroups/${group}` : ""}/providers/Microsoft.Authorization/locks`,
      apiVersion: MANAGEMENT_LOCKS,
    },
  ],
  compact: (item, full) => ({
    name: item.name,
    level: str(objOf(item.properties).level),
    scope: full ? lockScope(item.id) : shortScope(lockScope(item.id)),
  }),
  fields: ["name", "level", "scope"],
  detail: (item, full, _limit) => {
    const props = objOf(item.properties);
    const notes = str(props.notes);
    const owners = Array.isArray(props.owners)
      ? props.owners.map((owner) => str((owner as Record<string, unknown>).applicationId)).filter(Boolean)
      : [];
    return {
      body: {
        name: item.name,
        id: item.id,
        level: str(props.level),
        scope: lockScope(item.id),
        notes: full ? notes : truncate(notes, CELL_TRUNCATE).text,
        owners: joined(owners, full),
      },
    };
  },
  aggregate: (items) => {
    const byLevel: Record<string, number> = {};
    for (const item of items) {
      const level = str(objOf(item.properties).level) || "(unknown)";
      byLevel[level] = (byLevel[level] ?? 0) + 1;
    }
    return { byLevel };
  },
};

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const verb = args.positionals[0];
  const path = `lock ${verb}`;
  if (verb !== "list" && verb !== "show") {
    governanceInvalid("expected lock list|show", path);
  }
  if (args.positionals.length !== 1) {
    governanceInvalid(`unexpected argument \`${args.positionals[1]}\` for \`${path}\``, path);
  }
  assertKnownFlags(args, commandFlags(path), path, governanceLeafHelp(path));
  const profile = profileFromArgs(args);
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
    governanceInvalid("management-group scope is unsupported for lock reads; select subscriptions explicitly", path);
  }
  if (verb === "list") return runGovernanceList(profile, args, LOCKS, path);
  return runGovernanceShow(profile, args, LOCKS, path, (subscription, group, name) =>
    `/subscriptions/${subscription}${group ? `/resourceGroups/${group}` : ""}/providers/Microsoft.Authorization/locks/${name}`);
}
